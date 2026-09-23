import cds from '@sap/cds';
import { createHash } from 'node:crypto';

const VALID_SEVERITIES = ['Error', 'Warning', 'Success', 'Information'];
const VALID_SOURCES = [
  'MessageBox', 'MessageToast', 'MessagePopover', 'MessageManager', 'JSError', 'UnhandledRejection',
  'HttpError', 'ABAPMessage', 'WebDynproABAP'
];
// A report of an error within this window of the last one with the same fingerprint is the same interaction
// surfacing through another channel (e.g. HttpError + the MessageBox showing it), so it isn't stored again.
// Same default as the plugin's duplicateWindowMs, which already drops these client-side; this covers callers
// that don't (e.g. ABAP) and a single interaction split across two flushes.
const SAME_TRIGGER_WINDOW_MS = 2000;

// Truncate to the column length from db/schema.cds: HANA rejects the whole INSERT (and so the whole
// batch, which the plugin then re-queues forever) if a single value is too long.
function clip(value, maxLength) {
  return typeof value === 'string' && value.length > maxLength ? value.slice(0, maxLength) : value;
}

// "The same error" across calls and users. Deliberately excludes source, user and URL, so one failure
// reported through several channels is recognised as one; stored on every row for grouping repeats.
// Must match _errorKey() in app/error.capture.plugin/webapp/util/MessageInterceptor.js.
function fingerprint(entry) {
  const key = [entry.severity, entry.message, entry.messageCode, entry.appId, entry.tcode, entry.program]
    .map(v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim()))
    .join('\u0001');
  return createHash('sha1').update(key).digest('hex');
}

function withinWindow(a, b) {
  return Math.abs(new Date(a) - new Date(b)) <= SAME_TRIGGER_WINDOW_MS;
}

function normalize(entry, req) {
  const row = {
    timestamp: entry.timestamp || new Date().toISOString(),
    severity: VALID_SEVERITIES.includes(entry.severity) ? entry.severity : 'Error',
    message: entry.message,
    description: entry.description,
    messageCode: clip(entry.messageCode, 50),
    source: VALID_SOURCES.includes(entry.source) ? entry.source : 'MessageBox',
    appId: clip(entry.appId, 100),
    appTitle: clip(entry.appTitle, 200),
    tileId: clip(entry.tileId, 100),
    standardApp: !!entry.standardApp,
    url: entry.url,
    userId: clip(req.user?.id, 100),
    client: clip(entry.client, 10),
    userAgent: clip(entry.userAgent, 400),
    stack: entry.stack,
    additionalInfo: entry.additionalInfo,
    tcode: clip(entry.tcode, 20),
    program: clip(entry.program, 40)
    // occurrences/lastOccurredAt from plugin 1.0.3 are deliberately dropped
  };
  row.fingerprint = fingerprint(row);
  return row;
}

// Drops reports within the window of an earlier report of the same error in this call.
function dropSameTrigger(entries) {
  const kept = [];
  const lastKeptAt = new Map();
  for (const entry of [...entries].sort((x, y) => new Date(x.timestamp) - new Date(y.timestamp))) {
    const last = lastKeptAt.get(entry.fingerprint);
    if (last && withinWindow(entry.timestamp, last)) continue;
    lastKeptAt.set(entry.fingerprint, entry.timestamp);
    kept.push(entry);
  }
  return kept;
}

export default cds.service.impl(async function () {
  const { ErrorLogs } = this.entities;

  // Stores one row per interaction: skips a report that is the same interaction as one already stored.
  async function record(entries) {
    entries = dropSameTrigger(entries);
    const latest = await SELECT.from(ErrorLogs)
      .columns('fingerprint', 'max(timestamp) as timestamp')
      .where({ fingerprint: { in: [...new Set(entries.map(e => e.fingerprint))] } })
      .groupBy('fingerprint');
    const latestByFingerprint = new Map(latest.map(row => [row.fingerprint, row.timestamp]));
    const inserts = entries.filter(entry => {
      const last = latestByFingerprint.get(entry.fingerprint);
      return !(last && withinWindow(entry.timestamp, last));
    });
    if (inserts.length) await INSERT.into(ErrorLogs).entries(inserts);
  }

  this.on('logError', async (req) => {
    if (!req.data.message) req.reject(400, 'message is required');
    const entry = normalize(req.data, req);
    await record([entry]);
    return SELECT.one.from(ErrorLogs).where({ fingerprint: entry.fingerprint }).orderBy('timestamp desc');
  });

  this.on('logErrors', async (req) => {
    const entries = (req.data.entries || []).filter(e => !!e.message).map(e => normalize(e, req));
    if (!entries.length) return 0;
    await record(entries);
    return entries.length;
  });
});
