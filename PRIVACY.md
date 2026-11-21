# Privacy Policy for DevToolBox

DevToolBox does not include analytics, advertising, or browsing-history
collection. Accounts and Stripe test billing are optional and disabled in
default builds. Do not enter credentials, personal information, or confidential
data into developer-tool inputs.

- **Local processing:** JSON inspection, YAML conversion, JWT decoding, JSON
  comparison, and highlighted-text capture run inside the extension popup or
  side panel. Generation, redaction, and batch comparisons
  also run locally. These actions do not upload their inputs. JWT signatures
  are not verified. JWT tool inputs and tool outputs are not included in
  explicitly saved workspaces.
- **Temporary view continuity:** Current inputs, baseline, generated output,
  tool/tab selection, presets, and local note drafts are automatically kept
  in trusted `chrome.storage.session` memory so popup/full-page/side-panel
  switches retain the same values. This cache includes JWT inputs and outputs.
  It is separate for each Chrome window, is not written to disk or uploaded,
  and is cleared when the window closes, Chrome restarts, or the extension
  reloads. **Clear drafts** clears the current developer-tool inputs/output;
  local note drafts have their own form controls.
- **Explicit local storage:** Clicking **Save workspace** stores the workspace
  name, baseline/current JSON, applicable presets, and update time in this
  extension's `chrome.storage.local` on this Chrome profile. No cloud sync is
  provided. Use **Delete** to remove a saved workspace; **Clear drafts** only
  clears unsaved UI data. Uninstalling removes extension storage.
- **Backups and clipboard:** User-requested exports/downloads contain plain,
  unencrypted data on your computer. Imports read only the files you choose.
  Copying output writes it to your system clipboard. Other programs, clipboard
  history, or backup services may retain copies; manage those copies yourself.
- **Log-to-CSV conversion:** Clicking **Download CSV** sends only the input text
  over HTTPS to `https://developer-log-tools-pooja.onrender.com` to return CSV.
  Application code processes the log body in memory and does not intentionally
  persist it or log its contents. Infrastructure providers may retain request
  metadata such as IP addresses, timestamps, and errors; this is not a promise
  of zero infrastructure retention. Do not send sensitive logs.
- **Development builds:** Local notes use a separate loopback Django/SQLite
  backend and are not part of the store build. Deleting extension workspaces
  does not delete that SQLite database or existing downloaded backups.
- **Optional Google sign-in:** In account-enabled builds, Google supplies a
  verified account identifier and email to the backend for account creation
  and access checks. Google OAuth credentials and Google API tokens are not
  stored in workspaces. The backend retains the identifier/email and account
  creation date while the account exists. Google has its own privacy policies.
- **Application sessions:** A revocable application token is stored in trusted
  Chrome session memory and expires after 12 hours or disappears when Chrome
  closes. The backend stores only a token hash and expiry. One-time login
  attempts expire after ten minutes; successful login tickets expire after
  60 seconds. Expired records are removed by scheduled cleanup. Sign-out removes
  this browser's session and requests server revocation.
- **Optional TEST subscriptions:** Stripe receives the account email and an
  internal account ID when you request test checkout. Stripe hosts checkout
  and its portal. Our backend stores Stripe customer/checkout identifiers,
  subscription status, access expiry and deduplicated webhook receipt IDs,
  not card details. Signed test events and Stripe API reads determine access.
  Live payments are disabled. Use only fabricated test payment data.
- **Account deletion:** In account-enabled builds, **Delete server account**
  requires confirmation and deletes that backend identity, login attempts and
  application sessions. For accounts with a test billing customer it first
  requests deletion of that Stripe test customer, cancelling its subscriptions.
  A provider failure is reported rather than silently deleting the mapping.
  Local workspaces and downloaded backups remain until you delete them.
  Infrastructure/database backups and provider records may persist according
  to the configured provider retention policies. Webhook receipt IDs, which
  are not linked to an account record, are purged after 35 days by cleanup.
- **Contact:** General support is available through the GitHub repository.
  Do not post emails, tokens, payment details or identity documents in public
  issues. A private support channel and reviewed provider-retention disclosures
  must be provided before opening the account-enabled build to the public.
