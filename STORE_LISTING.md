# DevToolBox v1.1 store listing

**Title:** DevToolBox: JSON & API Workspace

**Summary:** Inspect JSON, convert YAML, decode JWTs and compare API responses in a local workspace. Export supported logs to CSV.

## Description

Stop switching between websites to inspect developer data. DevToolBox keeps
JSON, YAML, decoded JWTs, and API comparisons inside your browser, with a side
panel that stays open while you work.

- Format and validate JSON without rounding large integers or precise decimals.
- Expand JSON objects and arrays; search paths and values.
- Convert JSON to YAML and JSON-compatible YAML to JSON.
- Decode JWT headers, payloads, and expiry locally. Signatures are NOT verified.
- Compare two JSON responses. Object key order is ignored; array order matters.
- Save one named API workspace with baseline and current JSON on your device.
- Export/import workspace backups. No account or cloud sync.
- Capture selected webpage text only when you click.
- Convert supported logfmt, JSON Lines, and access logs to CSV. This action
  sends the input to our HTTPS backend; other listed tools process locally.

Open DevToolBox, click **Try sample**, then **Compare** to try it immediately.
Use **Open side panel** for a longer session. In **Workspaces**, enter both current
and baseline JSON and explicitly save your workspace.

JSON inputs are limited to 256 KiB, 64 nesting levels, and 10,000 values.
YAML aliases, explicit tags, non-string keys, and non-finite numbers are not
supported. Backups contain unencrypted data; keep them private. JWT decoding
is not authentication or signature verification.

This release is free. Paid subscriptions and sign-in are not available.
This statement applies to the default free build. Optional Google sign-in and
Stripe test billing require the separate [account setup](BILLING_SETUP.md).
Do not submit an account-enabled test build using an account-free disclosure.
Advanced model generation, batch comparisons, redaction presets, ignore rules,
and multiple workspaces are development-preview features, NOT included in the
published free build. Do not advertise them as purchasable Pro features yet.

Privacy and support:
- [Privacy policy](https://github.com/pooja7569/developer-text-tools/blob/main/PRIVACY.md)
- [Report an issue](https://github.com/pooja7569/developer-text-tools/issues)

## Screenshots and permission explanations

Use original screenshots of the shipped **free cloud build**: sample JSON
tree, response comparison, and one saved workspace in the side panel.
Do not show preview-only functionality as available to subscribers.

- `activeTab` + `scripting`: read highlighted main-frame text after a user click.
- `sidePanel`: keep the developer workspace open beside a webpage.
- `storage`: explicitly saved local API workspaces, not browsing history.
- Backend host permission: explicitly requested HTTPS log-to-CSV conversion.

Ask friends to actually use the tool and leave honest ratings if they wish.
Do not request a specific star rating, reward reviews, or promise paid-user
growth. Existing market offerings do not establish demand for this product.
