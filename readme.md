# Error Capture Plugin

An SAP Fiori Launchpad (FLP) plugin that captures the error and warning messages users see in **any UI5 app**
on the launchpad — standard SAP Fiori apps and custom-built UI5 apps alike — and lets the user **ask AI about
them**: the captured message's essential details are sent to the Ask AI service, which opens in a new tab.

Nothing is stored. There is no backend of its own: the plugin is a single HTML5 app.

## How the user gets to Ask AI

- **Error/warning dialogs** (`sap.m.MessageBox`) get an **Ask AI** button next to their own buttons. It opens
  Ask AI for exactly that message and leaves the dialog open; the dialog's own buttons, keyboard focus and
  `onClose` callback are unchanged. Confirmation dialogs (`MessageBox.confirm`) are questions, not errors, and
  don't get the button.
- **Launchpad header**: as soon as an error is captured in the open app, an **Ask AI** button appears in the
  shell header with a red badge counting the app's errors (one per distinct message; a repeat raises its
  "N times", not the badge). Pressing it opens **Errors in This App**: every error, newest first, with where it came
  from (dialog, the app's messages, failed backend call, script error), when, and its own **Ask AI** button. This
  covers errors shown without a `MessageBox` — Fiori Elements message dialogs/popovers, field validation, failed
  service calls the app handles quietly. **Clear List** empties it and hides the button; opening another app does
  the same (in-app navigation keeps it). On narrow screens the shell may move the button into its "•••" menu.
- **Notification**: when an error occurs that the user didn't see in a `MessageBox` (whose own Ask AI button
  already covers it), a toast says *"An error occurred in this app. Select Ask AI at the top right to get help
  with it."* Once, until the user has opened the list or another app (`notifyErrorsWithoutDialog`).

Both buttons use SAP's AI icon (`sap-icon://ai`). Ask AI only ever opens from a user's click: browsers block tabs
opened any other way, so the plugin never opens one on its own.

## What is sent to Ask AI

Query parameters on `askAiUrl` (the same ones the Performance Assistant in `zmsghelp` uses):

Parameter | Value
---|---
`message_id` | SAP message class, e.g. `M3` — from a message code of the form `<class>/<number>` (OData V2 Gateway and RAP error codes), empty otherwise
`message_number` | SAP message number, e.g. `305`
`transaction_code` | UI5 apps have no t-code: the app id. The semantic object-action from the URL (e.g. `SalesOrder-manage`, `Shell-home`) from the moment the user navigates, so errors raised while an app is still loading belong to it; replaced by its `sap.app/id` once the launchpad reports the app as loaded (`AppLifeCycle` `appLoaded`)
`message_text` | the message the user saw (cut to `askAiMaxMessageLength`). For a failed backend call, the backend's own message (see below)
`user_name` / `user_full_name` | logged-in launchpad user (`UserInfo` service); empty when `askAiIncludeUser` is `false`

One interaction often surfaces through several channels — a failed OData call carrying the SAP message code, and
the dialog showing its text without the code. Captures with the same text within `duplicateWindowMs` are merged,
so Ask AI from the dialog still gets `message_id`/`message_number`.

**Failed backend calls** (`util/ServiceError.js`) use the backend's own message from the error response: OData V2
(SAP Gateway, JSON or XML), OData V4 (RAP, CAP) or plain JSON. When the top-level message is only a wrapper
("An exception was raised.", "Multiple errors occurred…", a bare "Not Found"), the first specific error from the
details (`innererror.errordetails` / `details`) is used instead, with its message class/number. Without any usable
message (HTML error pages, empty bodies, network failures) the text describes the status in plain language plus
what was called, without keys or query options, which can carry business data — e.g. *"The requested data or
service was not found. (HTTP 404, GET ZSD_SRV/Orders)"*. The status texts are in `i18n.properties` (`httpError*`).

## Project layout

File or Folder | Purpose
---|---
`app/error.capture.plugin/webapp/util/MessageInterceptor.js` | captures messages (MessageBox, message model, JS errors, failed fetch/XHR calls incl. `$batch` operations, same-origin iframe apps) and adds the Ask AI button to MessageBox dialogs
`app/error.capture.plugin/webapp/util/AskAI.js` | builds the Ask AI URL from a captured message and opens it
`app/error.capture.plugin/webapp/util/ServiceError.js` | the user-facing message of a failed backend call: the backend's message from the error body, or a plain-language description of the status
`app/error.capture.plugin/webapp/util/AskAIHeaderItem.js` | the Ask AI button with the error badge in the launchpad header (`Extension` service)
`app/error.capture.plugin/webapp/util/ErrorListDialog.js` | the "Errors in This App" list the header button opens
`app/error.capture.plugin/webapp/manifest.json` | all configuration, under `sap.ui5/config/errorCapture`
`app/error.capture.plugin/webapp/test/` | local FLP sandbox + a demo tile to try the plugin without a real system
`mta.yaml`, `xs-security.json`, `app/error.capture.plugin/xs-app.json` | Cloud Foundry deployment: HTML5 repo + destination + XSUAA for Work Zone

## Configuration (`sap.ui5/config/errorCapture`)

Setting | Default | Meaning
---|---|---
`askAiUrl` | the Ask AI service | base URL the parameters above are appended to
`askAiIncludeUser` | `true` | send `user_name` / `user_full_name`
`askAiMaxMessageLength` | `1000` | longer message texts are cut (keeps the URL within browser limits)
`askAiIcon` | `sap-icon://ai` | icon of all Ask AI buttons
`addAskAiButtonToMessageBox` | `true` | Ask AI button in error/warning dialogs
`showAskAiHeaderButton` | `true` | Ask AI button with error badge in the launchpad header, and the error list
`notifyErrorsWithoutDialog` | `true` | toast pointing to the header button for errors not shown in a dialog
`capturedSeverities` | `Error`, `Warning` | which messages count as errors
`captureHttpErrors` / `httpErrorIgnoreUrlPatterns` | `true` / static resources, keep-alive, launchpad search (`/sap/es/ina/`, `/ESH_SEARCH_SRV/`), logout | failed service calls. Add any other launchpad-internal endpoints that fail in your landscape, or users get a badge for errors that aren't the app's
`captureUnhandledJsErrors` / `ignoreMessagePatterns` | `true` / `Script error.`, `ResizeObserver loop` | uncaught script errors, and message texts never offered to AI
`captureSameOriginIframes` | `true` | instrument apps Work Zone loads into a same-origin iframe
`duplicateWindowMs` | `2000` | captures of the same text within this window are one interaction; later ones count as repeats

## Try it locally (no real FLP needed)

```sh
cd app/error.capture.plugin
npm install
npm start             # opens webapp/test/flpSandbox.html
```

This boots a local Fiori Launchpad sandbox (UI5 from the public CDN) with the plugin registered as a
`bootstrapPlugin` and a "Demo Custom Tile" whose buttons raise a `MessageBox.error` (with message code
`M3/305`), a warning, a confirmation (no Ask AI), a message-model error, a failed service call and an uncaught
JS error.

## Deploying

### SAP BTP Cloud Foundry + SAP Build Work Zone

```sh
cf login -a <api-endpoint> --sso && cf target -o <org> -s <space>
mbt build && cf deploy mta_archives/error-plugin_2.1.0.mtar
```

`mta.yaml` deploys the plugin as an **HTML5 app** to the HTML5 Application Repository (built by `npm run build`
in `app/error.capture.plugin` from `ui5-deploy.yaml`; the UI5 runtime is *not* bundled), plus the destination and
XSUAA instances Work Zone needs to serve it. Then:

1. In Work Zone **Channel Manager**, refresh the HTML5 Apps content provider.
2. In **Content Manager** add the plugin app (type *plugin*) to your content and assign it to the site / a role
   of your users, then reload the site.

Upgrading from 1.x: the CAP service (`error-plugin-srv`), its HDI container (`error-plugin-db`) and the
`ErrorLogAdmin` role collection are no longer part of the MTA. `cf deploy` does not delete them — remove them
(and the HANA data in them) with `cf undeploy`/`cf delete` once you no longer need the stored logs.

### On-premise / ABAP Fiori Launchpad

Upload the built app (`npm run build` in `app/error.capture.plugin`, unzip `dist/error.capture.plugin.zip`) to a
BSP application (e.g. Fiori Tools "Deploy to ABAP"), create an `LPD_CUST` entry with plugin type `AL`
(UI5 plugin), and assign it to the relevant launchpad role(s).

## Notes / known limitations

- **Requires UI5 1.120 or later** on the launchpad (the header button uses the `Extension` service). Tested in
  the local sandbox with UI5 1.120.30 and 1.153.0.
- **SAP GUI for HTML / Web Dynpro ABAP transaction tiles aren't covered.** They aren't UI5 apps and normally run
  in a cross-origin iframe, so there is nothing in the browser the plugin can hook into.
- **Uncaught JS errors usually carry no detail.** When UI5 is loaded from a CDN (as in Work Zone), the browser
  hands the page only `"Script error."` for errors raised through UI5 code; those are ignored rather than sent to
  AI. Errors from same-origin scripts are captured with their text.
- Errors raised before the shell has loaded the plugin (bootstrap plugins load asynchronously) aren't captured.
- Dialogs/messages are merged with a failed call only when their texts match; an app showing its own wording for
  a failed call yields two separate errors, and only the failed call's carries the message code.
- `askAiUrl` defaults to the Ask AI service's **plain `http://`** endpoint. Message texts and user names travel in
  the URL query string (visible in browser history and server logs) — switch to an `https://` endpoint before
  productive use, or set `askAiIncludeUser` to `false`.
- Errors only written to the browser console (`console.error`, UI5 `Log.error`) aren't captured.
