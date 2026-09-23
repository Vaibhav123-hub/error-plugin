using { flp.errorcapture as db } from '../db/schema';

@path: '/odata/v4/error-log'
@requires: 'authenticated-user'
service ErrorLogService {

  // Admins can browse/purge captured messages; nobody writes to this entity directly
  // (inserts only ever happen server-side, via the logError/logErrors actions below).
  @restrict: [
    { grant: 'READ',   to: 'ErrorLogAdmin' },
    { grant: 'DELETE', to: 'ErrorLogAdmin' }
  ]
  entity ErrorLogs as projection on db.ErrorLogs;

  // Single call used to report one captured message - by the FLP plugin (MessageBox/MessageToast/
  // MessageManager/JS errors, all UI5-based) and directly by ABAP for WebGUI/Web Dynpro transaction
  // tiles, which the browser-side plugin can't see into (see abap/README.md).
  // Kept as an action (rather than exposing ErrorLogs for direct CREATE) so the
  // server can stamp timestamp/userId and reject fields the client shouldn't set.
  // Parameters are deliberately unbounded String: a declared length would make CAP reject the
  // whole call (and so the plugin's whole batch) for one over-long value - error-service.js
  // truncates to the column lengths in db/schema.cds instead.
  action logError (
    timestamp      : Timestamp,
    severity       : String,
    message        : LargeString,
    description    : LargeString,
    messageCode    : String,
    source         : String,
    appId          : String,
    appTitle       : String,
    tileId         : String,
    standardApp    : Boolean,
    url            : LargeString,
    client         : String,
    userAgent      : String,
    stack          : LargeString,
    additionalInfo : LargeString,
    tcode          : String,
    program        : String,
    // occurrences/lastOccurredAt: sent by plugin 1.0.3 - still accepted so its queued messages aren't
    // rejected (CAP refuses unknown properties), but ignored: every occurrence is its own row now
    occurrences    : Integer,
    lastOccurredAt : Timestamp
  ) returns ErrorLogs;

  // Batch variant so a caller can flush several messages (e.g. after being offline) in one round trip.
  action logErrors ( entries : many {
    timestamp      : Timestamp;
    severity       : String;
    message        : LargeString;
    description    : LargeString;
    messageCode    : String;
    source         : String;
    appId          : String;
    appTitle       : String;
    tileId         : String;
    standardApp    : Boolean;
    url            : LargeString;
    client         : String;
    userAgent      : String;
    stack          : LargeString;
    additionalInfo : LargeString;
    tcode          : String;
    program        : String;
    occurrences    : Integer;          // accepted from plugin 1.0.3 queues, ignored (see logError)
    lastOccurredAt : Timestamp;
  }) returns Integer;
}
