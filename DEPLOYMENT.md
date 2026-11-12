# Safe launch: local notes and public tools

## Architecture

```text
User clicks extension
  -> activeTab + scripting
  -> selected main-frame text -> React input (no upload)
  -> Format JSON -> local JSON.parse/JSON.stringify
  -> Download CSV -> HTTPS POST /api/log-to-csv/
                   -> validate -> pandas DataFrame -> escaped CSV
                   -> browser Blob download

Local build only:
  Notes -> loopback Django -> local SQLite

Cloud build:
  Stateless tools only -> Render/Gunicorn -> no database
```

The code does not claim to parse arbitrary logs. It supports:

- Key=value/logfmt records, with quoted strings and an optional text prefix.
  Double-quoted strings use JSON escapes. Escape literal backslashes in them.
- JSON Lines with one nonempty object per line. Nested data stays JSON text.
- Common/combined access records, including bracketed request records without
  a remote-address prefix.

Each nonblank line must match a supported format. Different records can use
different columns. Empty cells fill missing values. Limits are 256 KiB input,
2,000 lines, and 100 combined columns. Formulas beginning with `=`, `+`, `-`,
or `@` after whitespace receive a leading apostrophe, including headers.
The converter never evaluates log values, HTML, or JavaScript.

## Request contract

```http
POST /api/log-to-csv/
Content-Type: application/json
Accept: text/csv, application/json
X-Developer-Tools: 1
```

```json
{"log":"level=info code=200\nlevel=error code=500"}
```

Success returns HTTP 200, `text/csv`, `Content-Disposition`, and `no-store`.
Validation errors return HTTP 400 with a `detail` message. The endpoint limits
each client IP to 30 requests/minute per application process using DRF's
default local-memory cache. HTTP 429 reports the throttle.

This is a public utility, not an authenticated service. An extension ID, CORS,
or a custom header is not a secret. Before a broad launch, add an edge rate
limit and body-size limit with your hosting/CDN provider. Use a shared cache
for consistent cross-worker limits if demand grows. Local-memory throttles
are approximate and are not protection against distributed abuse.

## Environment isolation

`DJANGO_ENV` defaults to `development` for the existing Windows workflow.
Production must explicitly set it to `production`.

| Variable | Development | Production |
|---|---|---|
| `DJANGO_ENV` | `development` | `production` |
| `DJANGO_SECRET_KEY` | Optional ephemeral local key | Required, 50+ random characters |
| `DJANGO_ALLOWED_HOSTS` | Loopback defaults | Exact hostnames, comma-separated |
| `DJANGO_EXTENSION_ORIGINS` | Local extension ID | Exact extension origins |
| `DJANGO_SQLITE_PATH` | Optional local DB path | Not used |
| `DJANGO_TRUST_PROXY` | Unset | `true` behind Render's trusted HTTPS edge |

Settings read `os.environ`; they do not automatically load `.env` files.
The examples contain no passwords or API tokens. Do not put secrets in Vite
variables: all `VITE_` values are public, compiled extension configuration.

Production disables debug, requires explicit hosts/origins, enables secure
cookies, redirects to HTTPS, and enables HSTS for the service hostname.
HSTS does not automatically include all subdomains or request preload-list
membership. Enable those only after reviewing your domain's HTTPS coverage.
Trust forwarded HTTPS/client-IP headers only behind a proxy that controls
them; never expose this trusted-proxy configuration directly to the internet.

Production has no notes routes, and its database engine is deliberately
disabled. Do not copy SQLite into the cloud, and do not run migrations for
this stateless deployment. Persistent cloud notes require a separate
authenticated, per-user storage design, typically with PostgreSQL.

## Deploy to Render

No infrastructure has been provisioned by this project setup.
Review the provider's [current pricing](https://render.com/pricing) first.
The included Blueprint selects a paid Starter instance to avoid depending on
free-tier sleep behavior. No paid database is needed.

1. Review the code and confirm you may publish it. Create a Git repository
   under an account you control. Keep `.venv`, `node_modules`, SQLite, `.env`,
   downloads, and build folders out of the repository. Push only project
   source and lockfiles. Do not upload workplace data or logs.
2. In Render, choose **New -> Web Service** and connect that repository.
3. Choose a unique service name and set:
   - Runtime: **Python**
   - Root directory: `backend`
   - Build command: `pip install -r requirements.txt`
   - Start command:

     ```text
     gunicorn config.wsgi:application --bind 0.0.0.0:$PORT --workers 2 --threads 2 --timeout 30
     ```

   - Health check: `/api/greet/`
   - Instance: Starter or another reviewed plan
4. Set the environment variables:
   - `PYTHON_VERSION=3.13.17`
   - `DJANGO_ENV=production`
   - `DJANGO_SECRET_KEY`: generate a strong secret in your own terminal and
     enter it in Render's secret environment field. Do not paste it in chat
     or commit it. For example:

     ```powershell
     py -3.13 -c "import secrets; print(secrets.token_urlsafe(64))"
     ```

   - `DJANGO_ALLOWED_HOSTS=your-service.onrender.com` using the actual hostname
     Render assigns, without `https://` or a path.
   - `DJANGO_EXTENSION_ORIGINS=chrome-extension://YOUR_EXTENSION_ID`
     using the actual 32-character ID, not this placeholder.
   - `DJANGO_TRUST_PROXY=true`
5. Deploy. Verify the hostname in the dashboard and correct
   `DJANGO_ALLOWED_HOSTS` if Render assigned a suffix.
6. Open `https://your-service.onrender.com/api/greet/`. Expect the greeting.
   A production request to `/api/notes/` must return 404.
7. Test a valid CSV request using your extension, plus malformed input and a
   blocked origin. Never test using real customer data or credentials.

Alternatively, create a **Blueprint** from `render.yaml`. It uses the same
commands and prompts for the strong secret, hostname, and extension origins.
Generate the secret with the command above. Render's built-in `generateValue`
uses a base64-encoded 256-bit value, which is shorter than this project's
50-character minimum. Inspect the resource plan/cost before applying it.

Render terminates HTTPS. Gunicorn listens on Render's internal `$PORT`.
Do not run Django `runserver` publicly. No static server is required because
the React files ship inside the extension and the API serves no admin UI.

## Build the HTTPS extension

From the project root, after deploying your actual server:

```powershell
Set-Location .\frontend
$env:VITE_TOOLS_API_ORIGIN = "https://your-service.onrender.com"
npm.cmd run lint
npm.cmd test
npm.cmd run build:cloud
Remove-Item Env:\VITE_TOOLS_API_ORIGIN
```

Use your real origin. Do not include an API path, credentials, or query string.
The cloud build fails without an HTTPS origin. It generates `dist-cloud`
with that host permission and a CSP allowing connections only to that
origin. The local `dist` build and source manifest remain separate.

Load `dist-cloud` unpacked to test it, or zip its **contents**, with the
manifest at the zip root, for the Chrome Web Store:

```powershell
Compress-Archive -Path .\dist-cloud\* -DestinationPath .\extension-cloud.zip
```

Do not submit a bundle pointing to `tools.example.com`; that hostname is used
only in automated build tests. Rebuild with the deployed URL before packaging.
Do not include local notes, backups, SQLite, or backend environment files.

Before store publication, use the public key for the store-assigned extension
ID in the manifest, then update `DJANGO_EXTENSION_ORIGINS` to that exact ID.
The existing manifest key is public development metadata, not authentication.
Do not generate or publish a private signing key. Keep all JavaScript bundled;
do not add remote executable scripts or `eval`.

## Verify before launch

From the project root:

```powershell
Set-Location .\backend
.\.venv\Scripts\python.exe manage.py test api
.\.venv\Scripts\python.exe manage.py check
Set-Location ..\frontend
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

Also run `python manage.py check --deploy` in a production-configured
environment. Review any warnings; they are not permission to skip HTTPS.
This configuration deliberately reports `security.W005` and `security.W021`
because subdomain-wide HSTS and browser preload are not enabled. The service
hostname itself still sends one-year HSTS. Review domain coverage and ownership
before enabling the broader options; do not silence these checks blindly.
Gunicorn runs on Render's Linux host, not Windows. Local tests do not replace
the deployed HTTPS checks or actual Chrome permission/injection checks.

1. Select text on an HTTP/HTTPS page and click **Scrape Highlighted Text**.
2. Confirm input changes without a network upload.
3. Test a blocked page, no selection, and a password field.
4. Format valid JSON and verify invalid JSON stays visible with an error.
   Formatting uses JavaScript number semantics; do not use it to preserve
   integers beyond JavaScript's safe numeric precision.
5. Convert supported sample logs and inspect CSV quoting/column order.
6. Test unsupported lines, oversized input, and throttling.
7. Confirm cloud UI has no notes or backup controls and cannot reach notes APIs.
8. Verify actual Chrome downloads complete. A clicked link is not proof of
   a file saved successfully.

## Web Store launch requirements

Use the [store framework](STORE_LISTING.md) to write an accurate listing.
Provide original icons/screenshots, a support contact, and a real privacy
policy URL. Disclose `activeTab` and `scripting` as user-triggered selection
capture. Do not claim automatic or background scraping.

State that JSON formatting stays local, selected text stays in the popup until
the user requests CSV conversion, and CSV conversion transmits the input to
your HTTPS service. Describe the data types, purpose, retention, deletion
process, and infrastructure logs accurately. This app does not intentionally
store log bodies, but you must review Render, proxy, monitoring, and support
retention before promising "no collection" or "zero retention."

Keep the extension focused on related developer text tools. Do not market the
cloud bundle as a cloud snippet saver: cloud notes are intentionally disabled.
Plan updates, support, dependency patching, abuse monitoring, and a rollback.
Search traffic and approval are not guaranteed.

## References

- [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Render Django deployment](https://render.com/docs/deploy-django)
- [Render Blueprint specification](https://render.com/docs/blueprint-spec)
- [Render environment variables and generated secrets](https://render.com/docs/configure-environment-variables)
- [Chrome Web Store listing guidance](https://developer.chrome.com/docs/webstore/best-listing)
