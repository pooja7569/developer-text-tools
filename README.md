# DevToolBox v1.1

A Manifest V3 React popup that calls
`http://127.0.0.1:8000/api/greet/`.
The Day 2 notes feature saves plain-text notes in local SQLite.
Version 1.1 adds a side panel, precision-safe JSON inspection/search, JSON/YAML
conversion, JWT decoding, JSON comparison, and one explicitly saved local API
workspace. Advanced tools are available only in a development Pro preview.
Billing and sign-in are disabled by default; there are no real paid subscriptions.
Optional Google sign-in and Stripe **test-only** billing code is prepared.
See [account and billing setup](BILLING_SETUP.md) for dashboard configuration,
local testing and PostgreSQL deployment. No bank details are needed for testing.
Start with the [v1.1 testing and release guide](V1_1.md).
See [deployment and architecture](DEPLOYMENT.md) and the
[three-paragraph store framework](STORE_LISTING.md).

## Start the backend

Open PowerShell:

```powershell
# From the project root:
Set-Location .\backend
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py runserver 127.0.0.1:8000
```

Activation is not required, so no PowerShell execution-policy changes are needed.
Leave this terminal open. Stop the server with Ctrl+C.

## Load the extension

The initial build is in `frontend\dist`.

1. Open `chrome://extensions` in Google Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the project's `frontend\dist` folder.
5. Pin **DevToolBox** from the Extensions menu.
6. Open its popup, expand **Local backend and notes**, and click **Fetch from Backend**.
7. Expect: `Hello from your Django backend!`

## Day 2: Save and list notes

After rebuilding and reloading the extension:

1. Enter a note in **New note** (1-2,000 characters).
2. Click **Save note**. Expect **Note saved locally.**
3. Saved notes appear newest first, with their creation time.
4. Close and reopen the popup: the list loads automatically.
5. Use **Refresh notes** to reload the list. Drafts are lost when the popup
   closes, so save before clicking elsewhere.

Notes survive backend restarts because they are stored in `backend\db.sqlite3`,
not React state. Do not delete this database if you want to keep your notes.
There is no cloud sync or sign-in in this step.
Personal and work Chrome profiles share this same local backend/database.

### Edit and delete notes

- Click **Edit** below a note, change the text, then click **Save changes**.
- **Cancel** discards your unsaved edits without changing the saved note.
- Editing preserves the original creation time and list position.
- Click **Delete**, then **Delete permanently** to confirm. **Cancel** keeps it.
  Deletion cannot be undone.
- Other note actions and refresh are disabled while editing or confirming a
  deletion. Requests also disable controls until the operation finishes.
- Failed edits keep your draft; failed deletions keep the note visible. If a
  request times out, cancel and refresh before retrying to check what persisted.
- Closing the popup discards unsaved edits, just like an unsaved new note.

### Search saved notes

- Type in **Search notes** to filter instantly by note text. Matching is
  case-insensitive, ignores surrounding search whitespace, and treats
  punctuation literally.
- The count shows matching notes out of the total loaded. Matching notes keep
  their newest-first order.
- **Clear search** restores the full list. An empty or whitespace-only search
  also shows all notes.
- Search runs only in the popup against loaded notes. Typing does not send
  requests or change the database. Use **Refresh notes** to fetch newer data.
- Search is disabled while editing, confirming deletion, or waiting for a
  request, so changing the query cannot hide an open editor or confirmation.
- Saved edits and new notes follow the current filter immediately. If a
  successful save disappears from view, clear search to see it.
- The search resets when the popup closes. Sign-in remains deferred.

### Export a JSON backup

1. Keep Django running, then open the popup and click **Export backup**.
2. Keep the popup open until it reports the download was requested.
3. Check Chrome Downloads (`Ctrl+J`) for a timestamped
   `local-notes-...json` file. Chrome settings determine its save location.

The export fetches a fresh copy of **all saved notes**, not just search matches.
Unsaved drafts are not included. It does not modify or delete your database.
An empty database produces a valid backup with an empty notes array. If the
backend is unavailable, the export fails visibly instead of using stale data.

The JSON contains `version: 1`, a UTC `exported_at` timestamp, and a `notes`
array containing each note's `id`, `text`, and `created_at`. Text and line breaks
are preserved. This format is independent of the SQLite database file.

No new Chrome permissions, external services, or sign-in are required. The
file is plain text, not encrypted: keep it in a safe location and avoid
syncing sensitive content to unapproved services. Download initiation is
reported, not guaranteed completion; verify the file in Chrome Downloads.

### Import a JSON backup

1. Keep Django running. Under **Import JSON backup**, choose a backup file.
2. The popup validates it and shows the filename and number of notes.
3. Click **Confirm import**, or **Cancel import** to make no changes.
4. Keep the popup open until it reports the imported/skipped counts.

Imports **add** notes and never replace or delete existing notes. Identical
trimmed text is skipped, both within the file and against existing notes.
Comparison is case-sensitive. Reimporting the same unchanged backup therefore
does not add duplicates. New notes receive new local IDs and creation times;
the original backup IDs/times are validated but not restored.

Only version 1 backups are accepted: a valid `exported_at`, plus a `notes`
array with positive IDs, valid `created_at` timestamps, and nonblank text of
at most 2,000 characters. File limit: **1 MB (1,048,576 bytes)** and **500 notes**.
These limits apply to import only; export still includes every saved note.
An empty backup imports zero notes without changing anything.

Validation also runs on the backend, and the database import is atomic: a bad
entry rejects the entire file. On success, the full list refreshes and search
clears. On failure, the preview stays open; cancel and refresh before retrying
if a timeout occurred. No automatic retries or new Chrome permissions are used.

### Notes API

- `GET /api/notes/` returns an array of `{id, text, created_at}` objects.
- `POST /api/notes/` with JSON `{"text":"My note"}` returns the saved object
  with HTTP 201. Blank or overlong notes return HTTP 400 without being saved.
- `PATCH /api/notes/<id>/` with JSON `{"text":"Updated note"}` returns the
  updated object with HTTP 200. The same text validation applies.
- `DELETE /api/notes/<id>/` returns HTTP 204 with no body. Missing note IDs
  return HTTP 404. There are no bulk-delete or delete-all endpoints.
- `POST /api/notes/import/` accepts the version 1 backup object and returns
  `{imported, skipped, notes}` with HTTP 200. `notes` is the full newest-first
  list. Invalid backups return HTTP 400; oversized import bodies are rejected.
- All notes endpoints require `X-Local-Notes: 1`. Unlisted browser origins
  are rejected.
- Only JSON writes are accepted; the custom header forces ordinary websites
  through CORS preflight. It is a request guard, **not authentication**.
- If a save times out, refresh before retrying: it may already have reached
  the database. The extension does not automatically retry writes.

The manifest includes a public key (not a secret), fixing the extension ID to
`fhhldfhmeffllcnfcekopdomkcjmekhi`. Django allows exactly this extension origin.
No private key is stored. Changing the public key requires updating Django's
origin allowlist. This identifier and CORS policy are not authentication.

## After frontend changes

```powershell
# From the project root:
Set-Location .\frontend
npm.cmd run lint
npm.cmd test
npm.cmd run build
```

Click **Reload** on the extension's card in `chrome://extensions`, then close
and reopen the popup. Do not edit generated files inside `dist`.

Use the compiled popup, not `npm run dev`: a Vite browser tab has a different
origin and does not have Chrome extension host permissions.

## Checks

```powershell
# From the project root:
Set-Location .\backend
.\.venv\Scripts\python.exe manage.py check
.\.venv\Scripts\python.exe manage.py test api
Invoke-RestMethod http://127.0.0.1:8000/api/greet/
```

The PowerShell request checks connectivity, not browser permissions. Test the
loaded popup to verify the complete Chrome flow.

## Recreate dependencies if needed

Python 3.13 and a modern Node.js version compatible with Vite are required.
Python 3.13 was installed for the current Windows user during setup.

```powershell
# From the project root:
Set-Location .\backend
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe manage.py migrate

Set-Location ..\frontend
npm.cmd ci
npm.cmd run build
```

The Python virtual environment and npm dependencies are project-local.
Keep `requirements.txt` and `frontend\package-lock.json` in version control;
exclude the virtual environment, database, build output, and `node_modules`.

## Local-development boundaries

- Django uses the supported 5.2 LTS release line and binds only to loopback.
- Selection capture uses a one-shot, user-triggered script in the active tab.
  No persistent content script runs. A local service worker serializes workspace
  storage operations; it does not monitor tabs, capture traffic, or upload data.
- Requests omit cookies. Notes/greeting time out after five seconds; CSV after ten.
- CORS allows only this extension; browser host permission is also declared.
- The popup CSP restricts connections to `http://127.0.0.1:8000`.
- The greeting is public; the notes API has a local request guard, not user
  authentication. Use only non-sensitive test notes.
- Debug mode and Django's development server are local-only. The ephemeral
  Django secret changes on each process start, so signed sessions are not
  persistent. Do not use these settings for deployment or sensitive data.
- CORS and the notes request guard do not authenticate local processes or
  privileged extensions. Add authentication before storing private data.
- Corporate browser policies can still block unpacked extensions or loopback
  access. Use approved IT settings; do not bypass TLS or security controls.

## JSON, highlighted text, and CSV

1. Select text on an ordinary HTTP/HTTPS webpage.
2. Open the extension and click **Capture selection**.
3. The captured text replaces the input without uploading it.
4. Click **Format JSON** to format valid JSON locally without rounding numbers.
5. For logs, choose **Log to CSV** in the **Tool** selector, then click
   **Download CSV**. This sends only the input to the configured
   backend and starts a `logs.csv` download. Check Chrome Downloads with Ctrl+J.

Try this log input:

```text
level=info event=start duration=12
level=error event=stop message="Example failure"
```

The parser also accepts JSON Lines and common/combined access logs. It rejects
unsupported or malformed records without silently discarding them. Limits:
256 KiB UTF-8 input, 2,000 lines, and 100 combined columns. CSV escapes cells
that could act as spreadsheet formulas.

Chrome blocks injection on internal pages, the Web Store, and some managed
pages. Capture reads only the main frame; cross-origin iframes are not covered.
Password inputs are excluded. Avoid selecting sensitive content.

Rebuild after permission changes, reload the extension, and accept Chrome's
permission prompt if shown. Local notes, search, and backups still work in
`dist`; the separate `dist-cloud` build intentionally excludes them.

## Troubleshooting

- **Connection refused:** start Django; verify port 8000 is available.
- **Blank/stale popup:** rebuild, reload the extension, and reopen the popup.
- **Browser error:** right-click the popup, choose **Inspect**, and check Console
  and Network. Check Django's terminal for the matching request.
- **CORS error:** verify you loaded the compiled extension, the ID matches the
  allowlist, and the URL is exactly `http://127.0.0.1:8000/api/greet/`.
- **Managed-browser restriction:** inspect `chrome://policy` and contact IT.
