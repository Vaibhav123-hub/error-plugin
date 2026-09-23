namespace flp.errorcapture;

using { cuid, managed } from '@sap/cds/common';

/**
 * One row per message captured by the FLP Error Capture plugin (MessageBox / MessageToast /
 * MessagePopover / MessageManager / unhandled JS errors, all from UI5 apps on the launchpad),
 * or reported directly by ABAP for transaction-tile apps the plugin can't see into - SAP GUI
 * for HTML (WebGUI) and Web Dynpro ABAP don't run as UI5 components, so nothing in the browser
 * can intercept their messages; see abap/README.md for the ABAP-side integration.
 */
entity ErrorLogs : cuid, managed {
  timestamp      : Timestamp;                // when the message was raised
  severity       : String(20) enum {
    Error; Warning; Success; Information;
  };
  message        : LargeString;              // main message text shown to the user
  description    : LargeString;              // long text / technical details, if any
  messageCode    : String(50);                // backend message code (OData error, or ABAP "<msgid>/<msgno>")
  source         : String(30) enum {                 // where the message was raised/intercepted
    MessageBox; MessageToast; MessagePopover; MessageManager; JSError; UnhandledRejection;
    HttpError;                                // failed service call (fetch/XHR 4xx/5xx or failed $batch operation)
    ABAPMessage; WebDynproABAP;               // reported by ABAP - see abap/README.md
  };
  appId          : String(100);               // semantic object-action / component id (UI5) or t-code (ABAP)
  appTitle       : String(200);               // title of the app/tile as shown on the FLP
  tileId         : String(100);               // catalog tile / static tile id, if resolvable
  standardApp    : Boolean default false;     // true = standard SAP app, false = custom built
  url             : LargeString;              // browser URL / hash at the time of capture (UI5 sources only)
  userId         : String(100);               // FLP/ABAP user id (defaulted server-side from the logged-in user)
  client         : String(10);                // SAP client, if available
  userAgent      : String(400);
  stack          : LargeString;               // JS stack trace, for JSError / UnhandledRejection
  additionalInfo : LargeString;               // any extra JSON-stringified context sent by the caller
  tcode          : String(20);                // ABAP transaction code, for ABAPMessage / WebDynproABAP
  program        : String(40);                // ABAP program/include (sy-repid), for ABAPMessage / WebDynproABAP
  // One row per distinct error: repeats increment occurrences instead of adding rows.
  // `timestamp`/`userId` describe the first occurrence, these the latest.
  occurrences    : Integer default 1;
  lastOccurredAt : Timestamp;
  lastUserId     : String(100);
  fingerprint    : String(40);                // sha1 of severity/message/code/app/tcode/program - see srv/error-service.js
}
