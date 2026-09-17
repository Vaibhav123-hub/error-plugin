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

  // Single call used by the FLP plugin to report one captured message.
  // Kept as an action (rather than exposing ErrorLogs for direct CREATE) so the
  // server can stamp timestamp/userId and reject fields the client shouldn't set.
  action logError (
    timestamp      : Timestamp,
    severity       : String(20),
    message        : LargeString,
    description    : LargeString,
    messageCode    : String(50),
    source         : String(30),
    appId          : String(100),
    appTitle       : String(200),
    tileId         : String(100),
    standardApp    : Boolean,
    url            : LargeString,
    client         : String(10),
    userAgent      : String(400),
    stack          : LargeString,
    additionalInfo : LargeString
  ) returns ErrorLogs;

  // Batch variant so the plugin can flush a queue of messages (e.g. after being offline) in one round trip.
  action logErrors ( entries : many {
    timestamp      : Timestamp;
    severity       : String(20);
    message        : LargeString;
    description    : LargeString;
    messageCode    : String(50);
    source         : String(30);
    appId          : String(100);
    appTitle       : String(200);
    tileId         : String(100);
    standardApp    : Boolean;
    url            : LargeString;
    client         : String(10);
    userAgent      : String(400);
    stack          : LargeString;
    additionalInfo : LargeString;
  }) returns Integer;
}
