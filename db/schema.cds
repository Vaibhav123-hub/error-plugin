namespace flp.errorcapture;

using { cuid, managed } from '@sap/cds/common';

/**
 * One row per message captured by the FLP Error Capture plugin
 * (MessageBox / MessageToast / MessagePopover / MessageManager / unhandled JS errors).
 */
entity ErrorLogs : cuid, managed {
  timestamp      : Timestamp;                // when the message was raised in the browser
  severity       : String(20) enum {
    Error; Warning; Success; Information;
  };
  message        : LargeString;              // main message text shown to the user
  description    : LargeString;              // long text / technical details, if any
  messageCode    : String(50);                // backend message code, e.g. from OData error response
  source         : String(30) enum {                 // where the message was intercepted
    MessageBox; MessageToast; MessagePopover; MessageManager; JSError; UnhandledRejection;
  };
  appId          : String(100);               // semantic object-action / component id of the app
  appTitle       : String(200);               // title of the app/tile as shown on the FLP
  tileId         : String(100);               // catalog tile / static tile id, if resolvable
  standardApp    : Boolean default false;     // true = standard SAP Fiori app, false = custom built
  url             : LargeString;              // browser URL / hash at the time of capture
  userId         : String(100);               // FLP user id (defaulted server-side from the logged-in user)
  client         : String(10);                // SAP client, if available
  userAgent      : String(400);
  stack          : LargeString;               // JS stack trace, for JSError / UnhandledRejection
  additionalInfo : LargeString;               // any extra JSON-stringified context sent by the plugin
}
