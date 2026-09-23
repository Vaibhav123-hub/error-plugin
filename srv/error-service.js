import cds from '@sap/cds';

const VALID_SEVERITIES = ['Error', 'Warning', 'Success', 'Information'];
const VALID_SOURCES = [
  'MessageBox', 'MessageToast', 'MessagePopover', 'MessageManager', 'JSError', 'UnhandledRejection',
  'HttpError', 'ABAPMessage', 'WebDynproABAP'
];

// Truncate to the column length from db/schema.cds: HANA rejects the whole INSERT (and so the whole
// batch, which the plugin then re-queues forever) if a single value is too long.
function clip(value, maxLength) {
  return typeof value === 'string' && value.length > maxLength ? value.slice(0, maxLength) : value;
}

function normalize(entry, req) {
  return {
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
  };
}

export default cds.service.impl(async function () {
  const { ErrorLogs } = this.entities;

  this.on('logError', async (req) => {
    if (!req.data.message) req.reject(400, 'message is required');
    const entry = normalize(req.data, req);
    return await INSERT.into(ErrorLogs).entries(entry);
  });

  this.on('logErrors', async (req) => {
    const entries = (req.data.entries || []).filter(e => !!e.message).map(e => normalize(e, req));
    if (!entries.length) return 0;
    await INSERT.into(ErrorLogs).entries(entries);
    return entries.length;
  });
});
