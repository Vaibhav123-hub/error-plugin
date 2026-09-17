# Error Capture Plugin

An SAP Fiori Launchpad (FLP) plugin that captures message popups and screen
messages (`sap.m.MessageBox`, `sap.m.MessageToast`, the UI5 message
model/popover, and uncaught JS errors) raised by **any** app running on the
launchpad — standard SAP Fiori apps and custom-built apps alike — and
persists them through a CAP service backed by SAP HANA.

## Project layout

File or Folder | Purpose
---------|----------
`app/error.capture.plugin/` | the FLP plugin (UI5 component) and its message interceptor
`app/error.capture.plugin/webapp/test/` | local FLP sandbox + a demo custom tile to exercise the plugin without a real system
`db/schema.cds` | `ErrorLogs` entity that stores captured messages (HANA in production, SQLite for local dev)
`srv/error-service.cds` / `srv/error-service.js` | `ErrorLogService`, the CAP service the plugin reports messages to
`xs-security.json`, `mta.yaml` | XSUAA role (`ErrorLogAdmin`) and Cloud Foundry deployment descriptor (CAP srv + HDI/HANA container)

## How it works

1. **`app/error.capture.plugin/webapp/util/MessageInterceptor.js`** patches
   `sap.m.MessageBox.*` and `sap.m.MessageToast.show`, and listens to the
   shared UI5 message model (which backs the message popover / strip used by
   Fiori Elements list reports & object pages). It also listens for
   `window.onerror` / `unhandledrejection` for uncaught JS errors. This
   covers messages from standard SAP apps and custom-built apps the same
   way, since both use the same standard UI5 controls/APIs.
2. Every captured message is enriched with the current app context
   (semantic-object/action, app title, whether it looks like a standard SAP
   app or a custom one, URL, user agent) resolved via
   `sap.ushell.Container`'s `AppLifeCycle` service, then queued.
3. The queue is flushed periodically (default every 5s), when it gets large,
   and on page unload, via `POST` to the CAP service's `logErrors` batch
   action. A copy of the queue is kept in `sessionStorage` so a message isn't
   lost if the tab closes before the flush completes.
4. **`srv/error-service.js`** stamps `timestamp`/`userId` server-side and
   inserts into `ErrorLogs` (`db/schema.cds`), which CAP persists to HANA in
   production (SQLite automatically for local `cds watch`).
5. Captured messages can be browsed/purged through the `ErrorLogs` entity,
   restricted to the `ErrorLogAdmin` role (see `xs-security.json`).

All configuration (backend URL, which severities to capture, flush interval,
etc.) lives in `app/error.capture.plugin/webapp/manifest.json` under
`sap.ui5/config/errorCapture`, so it can be tuned per landscape without
touching code.

## Run the backend locally

```sh
npm install
npm run watch        # cds watch - serves ErrorLogService on SQLite in-memory
```

Try it:

```sh
curl -u admin:admin -X POST http://localhost:4004/odata/v4/error-log/logError \
  -H "Content-Type: application/json" \
  -d '{"severity":"Error","message":"Test error","source":"MessageBox","appId":"demoapp-display"}'

curl -u admin:admin http://localhost:4004/odata/v4/error-log/ErrorLogs
```

(The mocked local user `admin`/`admin` has the `ErrorLogAdmin` role, see
`package.json` → `cds.requires.auth.users`.)

## Try the plugin locally (no real FLP needed)

```sh
cd app/error.capture.plugin
npm install
npm start             # opens webapp/test/flpSandbox.html
```

This boots a minimal local Fiori Launchpad sandbox (via the public SAPUI5
CDN) with the plugin registered as a `bootstrapPlugin` and one demo tile
("Demo Custom Tile") that has buttons to trigger a `MessageBox.error`,
`MessageBox.warning`, `MessageToast`, a message-model validation message,
and an uncaught JS error. Open the browser console / Network tab to see each
one captured and POSTed to `ErrorLogService`. Point `backendBaseUrl` in the
plugin's `manifest.json` at your running `cds watch` instance (e.g.
`http://localhost:4004/odata/v4/error-log`) to see them land in `ErrorLogs`.

## Deploying

- **Backend**: `mta.yaml` builds the CAP service + an HDI deployer for the
  HANA schema (`db/schema.cds`) + an XSUAA instance with the `ErrorLogAdmin`
  role. Deploy with the standard CAP/MTA flow:
  ```sh
  mbt build && cf deploy mta_archives/error-plugin_1.0.0.mtar
  ```
- **Plugin**: build it with `npm run build` inside
  `app/error.capture.plugin` (requires SAPUI5 npm registry access, since
  `sap.ushell` is SAPUI5-only) and register the resulting component as an
  FLP plugin:
  - **On-premise / ABAP Fiori Launchpad**: upload the built app to a BSP
    application (e.g. via `@ui5/cli` + `ui5-task-nwabap-deployer` or Fiori
    Tools "Deploy to ABAP"), create an `LPD_CUST` entry with plugin type
    `AL` (UI5 plugin), and assign it to the relevant Launchpad role(s)/site.
  - **SAP Build Work Zone / BTP Launchpad service**: deploy the built app to
    the HTML5 Application Repository (add it as an `sap.app.embeds`/HTML5
    module to `mta.yaml`), then register it as a **plugin** content resource
    in the Launchpad site's Content Manager and assign it to the site.
  - In both cases, point `sap.ui5/config/errorCapture/backendBaseUrl` in the
    deployed plugin's `manifest.json` at the deployed CAP service URL (via a
    destination, if the plugin and service aren't served from the same
    origin — otherwise the browser CSRF/cookie flow used by
    `MessageInterceptor.js` won't work cross-origin).

## Notes / known limitations

- The same underlying error can legitimately surface through more than one
  channel (e.g. a Fiori Elements save error shown as both a `MessageBox` and
  a message-model entry) — both are captured as separate rows by design; if
  you need deduplication, do it downstream (e.g. group by
  `message`+`appId` within a short time window) rather than suppressing
  capture.
- `standardApp` is a heuristic based on the component id prefix
  (`sap.ui5/config/errorCapture/standardAppNamespacePrefixes` in
  `manifest.json`, default `sap.`/`com.sap.`) — adjust it to match your
  landscape's naming conventions for custom apps.
- CSRF token handling in `MessageInterceptor.js` is best-effort: it fetches
  a token if the backend requires one (as most CAP-behind-approuter setups
  do) and proceeds without one if the `GET` doesn't return a token (e.g.
  plain local `cds watch`).

## Learn More

Learn more about CAP at <https://cap.cloud.sap>.
