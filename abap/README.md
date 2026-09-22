# ABAP-side error capture (WebGUI / Web Dynpro ABAP)

The FLP plugin ([`app/error.capture.plugin`](../app/error.capture.plugin)) only sees messages
from **UI5** apps on the launchpad — it patches `sap.m.MessageBox`/`MessageToast` and listens to
the UI5 message model, none of which exist in a SAP GUI for HTML (WebGUI) transaction or a classic
Web Dynpro ABAP app. Those run in an iframe using a server-rendered, non-UI5 technology stack, so
there is nothing in the browser for the plugin to hook into.

This folder is the other half: **ABAP calls the CAP service directly**, the same way the plugin
does, via the `logError`/`logErrors` actions on `ErrorLogService` (see
[`srv/error-service.cds`](../srv/error-service.cds)). That works regardless of browser/origin
concerns and reports the real ABAP message text, not scraped HTML.

**Important expectation to set up front: this is opt-in per transaction, not automatic.**
Deploying this doesn't make every SAP GUI screen start reporting on its own — someone has to add a
call to `zcl_flp_error_capture` at the point each transaction raises a message. That's trivial for
transactions/programs you own; for **unmodified standard SAP transactions** it needs a supported
enhancement point/BAdI (see "Standard transactions" below), which your team has to identify for
your NetWeaver release — there's no single hook that exists unchanged across all releases.

## What's here

- [`zcl_flp_error_capture.clas.abap`](zcl_flp_error_capture.clas.abap) — a reference ABAP class
  with `report_message( )` and `report_exception( )`. **This has not been compiled or run against
  an ABAP system as part of this change** — there wasn't one available to test against. Review it,
  rename it into your own namespace, import it (SE24/ADT — it's plain source, not an abapGit
  package), and test it before relying on it.

## Setup

### 1. Get OAuth2 client credentials for the XSUAA instance

```sh
cf create-service-key error-plugin-auth error-plugin-abap-key
cf service-key error-plugin-auth error-plugin-abap-key
```

From the JSON output, note `clientid`, `clientsecret`, and `url` (the UAA base URL — the token
endpoint is `<url>/oauth/token`).

### 2. Get the CAP service's own URL

```sh
cf app error-plugin-srv
```

Note the route (host) — this is the target for the destination below; the path is
`/odata/v4/error-log`.

### 3. Create an RFC destination (SM59, or ADT's "HTTP Connections to External Server")

| Field | Value |
|---|---|
| Destination | `ERRORPLUGIN_SRV` (matches `gc_destination` in the class — change both if you rename it) |
| Connection type | `G` (HTTP connection to external server) |
| Target host / path prefix | the `error-plugin-srv` route from step 2 / `/odata/v4/error-log` |
| Logon & Security → Authentication | OAuth 2.0 |
| OAuth2 client profile | Token endpoint = `<uaa url>/oauth/token`, Client ID/Secret = from step 1, Grant type = Client Credentials |

If the SSL handshake fails, your backend's SSL client PSE (`STRUST`) may not yet trust the CA
that signed the CAP service's certificate — check with Basis.

Test it with SM59's **Connection Test** before wiring any ABAP code to it.

### 4. Validate the whole path once, independently of ABAP

`logError`/`logErrors` only require `@requires: 'authenticated-user'`, not the `ErrorLogAdmin`
role — no role-collection assignment is needed for the technical client. But this project's own
testing so far has only used browser session auth and the local mocked user, never a machine
(client-credentials) token, so **confirm that token type is actually accepted** before assuming
the ABAP side will work:

```sh
curl -s <uaa-url>/oauth/token -u '<clientid>:<clientsecret>' -d 'grant_type=client_credentials' \
  | python -c "import sys,json; print(json.load(sys.stdin)['access_token'])" > token.txt

curl -i -X POST https://<error-plugin-srv-route>/odata/v4/error-log/logError \
  -H "Authorization: Bearer $(cat token.txt)" -H "Content-Type: application/json" \
  -d '{"severity":"Error","message":"curl smoke test","source":"ABAPMessage","tcode":"ZTEST"}'
```

Expect `200`/`201` and the row to show up in `ErrorLogs`. If this returns `401`/`403`, the class
will fail the same way — debug it here first, not from inside ABAP.

## Usage

### Custom transactions/programs you own

Straightforward — call it at your existing message/exception points:

```abap
MESSAGE e021(zsd) WITH lv_material INTO DATA(lv_text).
zcl_flp_error_capture=>report_message(
  iv_msgty = 'E' iv_msgid = 'ZSD' iv_msgno = '021' iv_msgv1 = lv_material ).
MESSAGE lv_text TYPE 'E'.   " still shows the message to the user as before
```

or for a caught exception:

```abap
TRY.
    " ...
  CATCH cx_root INTO DATA(lx_error).
    zcl_flp_error_capture=>report_exception( lx_error ).
    RAISE SHORTDUMP lx_error.   " or however you already handle it - unchanged
ENDTRY.
```

### Standard, unmodified SAP transactions

You can't insert a call into SAP's own code without a modification (unsupported). Options, in
order of how invasive they are:

1. **Start with custom transactions only** and treat standard-transaction coverage as a later
   phase — this alone covers everything your team builds and assigns to a tile.
2. **A BAdI or enhancement spot**, if one exists for the relevant transaction on your release —
   this has to be identified by your ABAP/Basis team against your actual system; there is no
   generic answer that holds across NetWeaver versions and support packages.
3. **A global hook on the message-runtime** (e.g. an implicit enhancement on the function module
   the `MESSAGE` statement uses internally to build message text) — technically possible and used
   by some central-logging add-ons, but higher-risk (support-package upgrades can move/change it)
   and should go through your normal change-control process, not be treated as a quick add.

### Web Dynpro ABAP

Same constraint as above: custom WDA components can call `report_message`/`report_exception`
directly wherever they already call `wd_message_manager->report_*`; standard WDA apps need the
same BAdI/enhancement investigation as standard classic transactions.

## Data mapping notes

- `appId` is set to the t-code, so ABAP-originated rows can be filtered/grouped the same way UI5
  rows are filtered by their semantic-object/component id.
- `messageCode` is `<msgid>/<msgno>` (e.g. `ZSD/021`) when a message class/number was given.
- `severity` maps from `SY-MSGTY`: `E`/`A`/`X` → `Error`, `W` → `Warning`, `S` → `Success`,
  `I` → `Information`.
- `client` is `SY-MANDT`.
- `url`, `userAgent`, `stack` are left blank for ABAP-originated rows — they're browser-specific
  and don't apply.
