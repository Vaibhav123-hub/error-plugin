import cds from '@sap/cds';
import { createHash } from 'node:crypto';

const VALID_SEVERITIES = ['Error', 'Warning', 'Success', 'Information'];
const VALID_SOURCES = [
  'MessageBox', 'MessageToast', 'MessagePopover', 'MessageManager', 'JSError', 'UnhandledRejection',
  'HttpError', 'ABAPMessage', 'WebDynproABAP'
];
const MAX_OCCURRENCES_PER_CALL = 100000;
// A single report of an error within this window of its last occurrence is the same trigger surfacing through
// another channel (e.g. HttpError + the MessageBox showing it), not a repeat. Same default as the plugin's
// duplicateWindowMs, which already collapses these client-side; this covers callers that don't (e.g. ABAP).
const SAME_TRIGGER_WINDOW_MS = 2000;

// Truncate to the column length from db/schema.cds: HANA rejects the whole INSERT (and so the whole
// batch, which the plugin then re-queues forever) if a single value is too long.
function clip(value, maxLength) {
  return typeof value === 'string' && value.length > maxLength ? value.slice(0, maxLength) : value;
}

// "The same error" across calls and users. Deliberately excludes source, user and URL, so one failure
// reported through several channels, or repeated later, lands on one row.
// Must match _errorKey() in app/error.capture.plugin/webapp/util/MessageInterceptor.js.
function fingerprint(entry) {
  const key = [entry.severity, entry.message, entry.messageCode, entry.appId, entry.tcode, entry.program]
    .map(v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim()))
    .join('\u0001');
  return createHash('sha1').update(key).digest('hex');
}

function isSameTrigger(entry, lastOccurredAt) {
  return entry.occurrences === 1 && !!lastOccurredAt &&
    Math.abs(new Date(entry.timestamp) - new Date(lastOccurredAt)) <= SAME_TRIGGER_WINDOW_MS;
}

function laterOf(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) >= new Date(b) ? a : b;
}

function normalize(entry, req) {
  const timestamp = entry.timestamp || new Date().toISOString();
  const occurrences = Number.parseInt(entry.occurrences, 10);
  const row = {
    timestamp,
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
    program: clip(entry.program, 40),
    occurrences: occurrences > 0 ? Math.min(occurrences, MAX_OCCURRENCES_PER_CALL) : 1,
    lastOccurredAt: laterOf(timestamp, entry.lastOccurredAt)
  };
  row.lastUserId = row.userId;
  row.fingerprint = fingerprint(row);
  return row;
}

// Merges entries with the same fingerprint within one call.
function mergeByFingerprint(entries) {
  const merged = new Map();
  for (const entry of entries) {
    const existing = merged.get(entry.fingerprint);
    if (!existing) {
      merged.set(entry.fingerprint, entry);
      continue;
    }
    if (isSameTrigger(entry, existing.lastOccurredAt)) continue;
    existing.occurrences += entry.occurrences;
    existing.lastOccurredAt = laterOf(existing.lastOccurredAt, entry.lastOccurredAt);
  }
  return [...merged.values()];
}

export default cds.service.impl(async function () {
  const { ErrorLogs } = this.entities;

  // Inserts new errors; for an error already on record, bumps its counter and last-occurrence info instead.
  async function record(entries) {
    const known = await SELECT.from(ErrorLogs)
      .columns('ID', 'fingerprint', 'lastOccurredAt')
      .where({ fingerprint: { in: entries.map(e => e.fingerprint) } });
    const knownByFingerprint = new Map(known.map(row => [row.fingerprint, row]));

    const inserts = [];
    for (const entry of entries) {
      const row = knownByFingerprint.get(entry.fingerprint);
      if (!row) {
        inserts.push(entry);
        continue;
      }
      if (isSameTrigger(entry, row.lastOccurredAt)) continue;
      await UPDATE(ErrorLogs, row.ID).with({
        occurrences: { '+=': entry.occurrences },
        lastOccurredAt: laterOf(row.lastOccurredAt, entry.lastOccurredAt),
        lastUserId: entry.lastUserId
      });
    }
    if (inserts.length) await INSERT.into(ErrorLogs).entries(inserts);
  }

  this.on('logError', async (req) => {
    if (!req.data.message) req.reject(400, 'message is required');
    const entry = normalize(req.data, req);
    await record([entry]);
    return SELECT.one.from(ErrorLogs).where({ fingerprint: entry.fingerprint });
  });

  this.on('logErrors', async (req) => {
    const entries = (req.data.entries || []).filter(e => !!e.message).map(e => normalize(e, req));
    if (!entries.length) return 0;
    await record(mergeByFingerprint(entries));
    return entries.length;
  });
});
