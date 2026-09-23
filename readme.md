# Error Capture Plugin

An SAP Fiori Launchpad (FLP) plugin that captures message popups and screen
messages (`sap.m.MessageBox`, `sap.m.MessageToast`, the UI5 message
model/popover, and uncaught JS errors) raised by **any UI5 app** running on
the launchpad — standard SAP Fiori apps and custom-built UI5 apps alike —
and persists them through a CAP service backed by SAP HANA. Transaction
tiles that launch SAP GUI for HTML (WebGUI) or Web Dynpro ABAP aren't UI5
apps, so the plugin can't see into them; those are covered separately by
ABAP calling the same CAP service directly — see
[`abap/README.md`](abap/README.md).

## Project layout

File or Folder | Purpose
---------|----------
`app/error.capture.plugin/` | the FLP plugin (UI5 component) and its message interceptor
`app/error.capture.plugin/webapp/test/` | local FLP sandbox + a demo custom tile to exercise the plugin without a real system
`app/error.capture.plugin/xs-app.json`, `ui5-deploy.yaml` | approuter routes (`/odata/*` → CAP service) and HTML5-repo build config for the plugin
`db/schema.cds` | `ErrorLogs` entity that stores captured messages (HANA in production, SQLite for local dev)
`srv/error-service.cds` / `srv/error-service.js` | `ErrorLogService`, the CAP service the plugin (and ABAP) report messages to
`xs-security.json`, `mta.yaml` | XSUAA role (`ErrorLogAdmin`) and Cloud Foundry deployment descriptor (CAP srv + HDI/HANA container + HTML5 plugin + destinations)
`abap/` | ABAP-side reporting for WebGUI/Web Dynpro transaction tiles the plugin can't reach — see [`abap/README.md`](abap/README.md)

## How it works

1. **`app/error.capture.plugin/webapp/util/MessageInterceptor.js`** patches
   `sap.m.MessageBox.*` and `sap.m.MessageToast.show`, and listens to the
   shared UI5 message model (which backs the message popover / strip used by
   Fiori Elements list reports & object pages). It also listens for
   `window.onerror` / `unhandledrejection` for uncaught JS errors. This
   covers messages from standard SAP apps and custom-built apps the same
   way, since both use the same standard UI5 controls/APIs.
   It also wraps `fetch` and `XMLHttpRequest` to record **failed service
   calls** (`source: HttpError`): any 4xx/5xx response or network failure,
   plus individual failed operations inside an OData `$batch` (which
   itself returns 200). The OData error message/code is extracted from the
   response body. Static resources are skipped via
   `httpErrorIgnoreUrlPatterns`, and the plugin never reports its own calls.
   Apps Work Zone loads into a **same-origin iframe** get the same
   instrumentation (MessageBox, MessageToast, message model, JS errors,
   service calls) as soon as their frame loads; cross-origin frames can't
   be reached by design.
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
plugin's `manifest.json` at your running `cds watch` instance using an
**absolute** URL (e.g. `http://localhost:4004/odata/v4/error-log`; the
default is relative and only makes sense behind an approuter) to see them land in `ErrorLogs`.

## Deploying

### SAP BTP Cloud Foundry + SAP Build Work Zone (wired up in `mta.yaml`)

```sh
cf login -a <api-endpoint> --sso && cf target -o <org> -s <space>
mbt build && cf deploy mta_archives/error-plugin_1.0.0.mtar
```

`mta.yaml` deploys, in one go:

- the CAP service (`error-plugin-srv`) + an HDI deployer for the HANA schema
  and an XSUAA instance with the `ErrorLogAdmin` role,
- the plugin as an **HTML5 app** in the HTML5 Application Repository
  (`error-plugin-ui`, built by `npm run build` in `app/error.capture.plugin`
  from `ui5-deploy.yaml` - a plain zip, the UI5 runtime is *not* bundled),
- the destination `srv-api` (with the user's token forwarded) that the
  plugin's `xs-app.json` routes `/odata/*` to, i.e. to the CAP service.

The plugin's `backendBaseUrl` (`odata/v4/error-log` in `manifest.json`) is
deliberately **relative**: `MessageInterceptor.js` resolves it against the
plugin's own resource path, so requests hit the plugin's approuter routes
rather than the launchpad's origin. Only use an absolute URL for local
development (see above).

After the deploy:

1. Assign the `ErrorLogAdmin (error-plugin <org>-<space>)` role collection to
   whoever should read `ErrorLogs` (not needed to *report* messages).
2. In Work Zone **Channel Manager**, refresh the HTML5 Apps content provider.
3. In **Content Manager** add the plugin app (type *plugin*) to your content
   and assign it to the site / a role of your users, then reload the site.

### On-premise / ABAP Fiori Launchpad

Upload the built app (`npm run build` in `app/error.capture.plugin`, unzip
`dist/error.capture.plugin.zip`) to a BSP application (e.g. Fiori Tools
"Deploy to ABAP"), create an `LPD_CUST` entry with plugin type `AL`
(UI5 plugin), and assign it to the relevant Launchpad role(s). Set
`backendBaseUrl` in the deployed `manifest.json` to a URL that reaches the CAP
service same-origin (e.g. a reverse-proxy path/web dispatcher rule), because
the browser cookie/CSRF flow in `MessageInterceptor.js` doesn't work
cross-origin.

## Transaction tiles (SAP GUI / Web Dynpro ABAP, launched by t-code)

Tiles that launch a t-code run SAP GUI for HTML (WebGUI) or Web Dynpro ABAP
in an iframe — server-rendered technology with no `sap.m.MessageBox`, no UI5
message model, nothing the plugin's JS can hook into. Even genuine JS errors
inside that iframe aren't reachable from the shell's `window.onerror` across
the iframe boundary in general (browsers don't propagate iframe errors to
the parent window).

So this is handled the other way round: ABAP calls `ErrorLogService`
directly, the same actions the plugin uses (`logError`/`logErrors`), via a
reference class and setup guide in [`abap/README.md`](abap/README.md). Rows
from this path use `source: ABAPMessage` / `WebDynproABAP`, and carry `tcode`
and `program` instead of a UI5 `appId`. **It's opt-in per transaction** —
your ABAP team wires the call into custom transactions directly, and into
standard ones via whatever enhancement/BAdI your release provides (there
isn't a single hook that's guaranteed to exist everywhere); see that guide
for the trade-offs.

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
- A failed service call and the error dialog an app shows for it are two
  rows (`HttpError` + `MessageBox`), again by design.
- Errors only written to the browser console (`console.error`, UI5
  `Log.error`) aren't captured — they're not shown to the user and are
  mostly framework noise.
- `MessageToast` is only stored when `Information` is in
  `capturedSeverities` (default: `Error`, `Warning` only).
- CSRF token handling in `MessageInterceptor.js` is best-effort: it fetches
  a token if the backend requires one (as most CAP-behind-approuter setups
  do) and proceeds without one if the `GET` doesn't return a token (e.g.
  plain local `cds watch`).

## Learn More

Learn more about CAP at <https://cap.cloud.sap>.
