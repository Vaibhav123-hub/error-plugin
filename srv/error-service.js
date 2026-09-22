import cds from '@sap/cds';

const VALID_SEVERITIES = ['Error', 'Warning', 'Success', 'Information'];
const VALID_SOURCES = [
  'MessageBox', 'MessageToast', 'MessagePopover', 'MessageManager', 'JSError', 'UnhandledRejection',
  'ABAPMessage', 'WebDynproABAP'
];

function normalize(entry, req) {
  return {
    timestamp: entry.timestamp || new Date().toISOString(),
    severity: VALID_SEVERITIES.includes(entry.severity) ? entry.severity : 'Error',
    message: entry.message,
    description: entry.description,
    messageCode: entry.messageCode,
    source: VALID_SOURCES.includes(entry.source) ? entry.source : 'MessageBox',
    appId: entry.appId,
    appTitle: entry.appTitle,
    tileId: entry.tileId,
    standardApp: !!entry.standardApp,
    url: entry.url,
    userId: req.user?.id,
    client: entry.client,
    userAgent: entry.userAgent,
    stack: entry.stack,
    additionalInfo: entry.additionalInfo,
    tcode: entry.tcode,
    program: entry.program
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
