# Google sign-in and Stripe TEST billing

## What is prepared

- Optional Google sign-in using Google's verified subject ID and email.
- Backend authorization-code flow with state/nonce validation.
- One-time, 60-second login tickets bound to an extension-generated PKCE
  verifier. The Google client secret never enters the extension.
- Revocable 12-hour application sessions. Only hashed application tokens are
  stored server-side. The extension stores its token in trusted
  `chrome.storage.session`, not local storage or workspace backups.
- Fixed **$1 USD/month TEST subscription**, hosted Stripe Checkout, customer
  portal, signed webhooks, and server reconciliation of access.
- Duplicate open checkouts are reused; existing subscriptions go through the
  portal instead of creating another subscription.
- Failed/expired/cancelled subscriptions remove test Pro access. Cancelling
  at period end keeps access until the paid test period ends.
- Server account deletion with confirmation, including cancellation of its
  Stripe test subscriptions. Local workspaces and downloads are kept.
- A persistent PostgreSQL configuration for deployment.

**No real payments are possible in this implementation. Live Stripe keys and
live webhook events are rejected. No bank details are needed to write or
automatically test this code.** Google/Stripe dashboards still require accounts,
credentials and provider approval where applicable. These have not been
created, configured or verified on your behalf.

### Cost-conscious architecture chosen

Keep the existing Django service. Use its local SQLite database for development,
and a small managed PostgreSQL database when deploying accounts. Do not pay
for a second authentication server, separate billing microservice, or workspace
cloud storage. A managed provider's free allowance can be used for testing if
available; review its current pricing, sleep behavior, backups and limits.
The existing Render free service still sleeps and can time out.

PostgreSQL is mandatory when accounts are enabled in production. Render's
ephemeral filesystem must not hold account/subscription SQLite data. The old
stateless CSV-only deployment still works unchanged while accounts stay disabled.

## 1. Configure Google sign-in

Use your personal/approved provider account, not company credentials.

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview)
   and create/select a project.
2. Configure branding, support contact, privacy URL, and audience.
3. Keep the consent screen in **Testing** and add your own Google account as
   a test user. Public availability may require publishing/verification.
4. Create an OAuth client with type **Web application**, not Chrome extension.
   The backend, not the extension, exchanges the Google authorization code.
5. Add this exact authorized redirect URI for local development:

   ```text
   http://127.0.0.1:8000/api/account/google/callback/
   ```

6. For deployment, also register the exact real callback URI, for example:

   ```text
   https://developer-log-tools-pooja.onrender.com/api/account/google/callback/
   ```

7. Copy the client ID and secret into your private server environment. Do not
   put the secret in React, Vite variables, Git, screenshots or chat.

The extension uses `chrome.identity.launchWebAuthFlow`. After Google returns to
the server, the server redirects to the exact allowed extension's
`https://EXTENSION_ID.chromiumapp.org/auth` URL with a one-time ticket, not an
application access token. No Google API access/refresh tokens are retained.

## 2. Run sign-in locally first, without billing

In a dedicated PowerShell terminal:

```powershell
Set-Location C:\Users\v-naresri\ChromeProject\backend
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:DJANGO_ACCOUNTS_ENABLED = "true"
$env:DJANGO_PUBLIC_ORIGIN = "http://127.0.0.1:8000"
$env:GOOGLE_CLIENT_ID = Read-Host "Google web OAuth client ID"
$env:GOOGLE_CLIENT_SECRET = [System.Net.NetworkCredential]::new(
    "", (Read-Host "Google client secret" -AsSecureString)
).Password
.\.venv\Scripts\python.exe manage.py migrate accounts
.\.venv\Scripts\python.exe manage.py runserver 127.0.0.1:8000
```

Environment values belong to this terminal. Settings do **not** automatically
load `.env` files. Close the terminal to discard these environment values.
Do not change the default local extension ID or upload your existing SQLite DB.

In another terminal:

```powershell
Set-Location C:\Users\v-naresri\ChromeProject\frontend
$env:VITE_ACCOUNTS_ENABLED = "true"
npm.cmd run build
Remove-Item Env:\VITE_ACCOUNTS_ENABLED
```

Reload `frontend\dist` in `chrome://extensions`; accept the new **identity**
permission. Open **DevToolBox -> Open side panel -> Account -> Sign in with Google**.
Choose your configured test user. Expect your email and **Free access**.
Billing controls remain disabled until step 3.

Closing/reopening the extension page keeps a session; closing Chrome or waiting
12 hours requires signing in again. Sign-out revokes the current server token.
Failed sign-out still clears this browser's session and explicitly reports that
server revocation may have failed.

## 3. Prepare Stripe sandbox/test mode

1. Create/sign in to a Stripe account if eligible. Use a **sandbox or test mode**.
   Do not enter bank details, activate live payments, or use real cards.
2. Create a test product **DevToolBox Pro**, with one **$1.00 USD monthly recurring**
   price, licensed/per-unit billing, no trial. Copy its `price_...` ID.
3. Copy the **test secret key** starting `sk_test_...`. No publishable key is
   needed because Checkout is hosted. Never use an `sk_live_...` key.
4. Configure the test **customer portal** to allow subscription cancellation
   and payment-method updates. Do not enable plan switching to arbitrary prices.
5. Install the [official Stripe CLI](https://docs.stripe.com/stripe-cli) using
   the provider's instructions. Authenticate it yourself.
6. Forward test events in a separate terminal:

   ```powershell
   stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,invoice.paid,invoice.payment_failed --forward-to http://127.0.0.1:8000/api/account/billing/webhook/
   ```

7. Keep that terminal open. Copy its `whsec_...` signing secret into the backend
   terminal in the next step. A dashboard endpoint and the CLI have different
   signing secrets; use the correct one.

Account availability varies. For example, Stripe currently describes new
India-based accounts as [invite-only](https://support.stripe.com/questions/how-can-i-open-a-stripe-account-in-india).
Do not invent a foreign business/address or bypass onboarding. If you cannot
obtain a test account, keep billing disabled: automated tests still run with
provider-boundary mocks. A different provider requires its own approved integration.

Stop Django with Ctrl+C. In the **same backend terminal**, add:

```powershell
$env:DJANGO_BILLING_TEST_ENABLED = "true"
$env:STRIPE_PRICE_ID = Read-Host "Stripe TEST monthly price ID"
$env:STRIPE_SECRET_KEY = [System.Net.NetworkCredential]::new(
    "", (Read-Host "Stripe TEST secret key" -AsSecureString)
).Password
$env:STRIPE_WEBHOOK_SECRET = [System.Net.NetworkCredential]::new(
    "", (Read-Host "Stripe webhook signing secret" -AsSecureString)
).Password
.\.venv\Scripts\python.exe manage.py runserver 127.0.0.1:8000
```

In the extension:

1. **Refresh account/access**, then **Start $1/month TEST checkout**.
2. Confirm Stripe clearly indicates test mode. Use only a
   [Stripe test card](https://docs.stripe.com/testing), such as
   `4242 4242 4242 4242`, a future expiry and a test CVC.
3. Finish checkout, return to the extension, and **Refresh account/access**.
4. Expect **Test Pro access**. Try code generation and a second workspace.
5. Open **Manage test subscription** and schedule cancellation. Access should
   remain until the test paid period ends. Immediate cancellation/payment
   failure must remove access on the next refresh/advanced action.
6. Confirm a checkout success URL alone cannot unlock Pro.
7. Sign out: advanced actions lock, but all saved workspaces remain
   viewable/exportable/deletable.
8. Test **Delete server account** only with disposable test data. It requires
   confirmation and cancels that account's test subscriptions.

The server ignores client-supplied prices/customer IDs/Pro flags. Webhooks
verify the raw-body signature, reject live events, deduplicate receipts and
fetch current Stripe state rather than trusting event delivery order.
The extension also refreshes server access before advanced actions and
workspace mutations. Network errors do not grant cached Pro access.

Local-only tools are distributed JavaScript, so determined users can modify
their own unpacked copy. This design does not claim tamper-proof offline DRM.
Workspaces/JSON/JWT contents are never sent to account/billing endpoints.

## 4. Prepare deployment, without activating live payments

Do this only after local Google and Stripe tests succeed.

1. Create a managed PostgreSQL database if you approve the provider/cost.
   Save its TLS connection URL as a secret `DATABASE_URL` in Render.
2. Keep the current stateless production settings and add:

   ```text
   DJANGO_ACCOUNTS_ENABLED=true
   DJANGO_BILLING_TEST_ENABLED=true
   DJANGO_PUBLIC_ORIGIN=https://developer-log-tools-pooja.onrender.com
   DATABASE_URL=<private PostgreSQL URL>
   GOOGLE_CLIENT_ID=<web client ID>
   GOOGLE_CLIENT_SECRET=<private client secret>
   STRIPE_SECRET_KEY=<sk_test_...>
   STRIPE_PRICE_ID=<test price_...>
   STRIPE_WEBHOOK_SECRET=<dashboard test endpoint whsec_...>
   ```

3. Set `DJANGO_EXTENSION_ORIGINS` to the **exact** published extension origin,
   plus any deliberately approved test-extension origins. Do not allow arbitrary
   extensions. Add the deployed Google callback URI in Google.
4. Run this migration once against the account database before enabling
   traffic (Render pre-deploy command or an approved administrative shell):

   ```text
   python manage.py migrate accounts --noinput
   ```

   Do not migrate/upload local notes. `api/notes/` stays unavailable in production,
   even after adding a PostgreSQL database.
5. Register a **test** Stripe webhook at
   `https://developer-log-tools-pooja.onrender.com/api/account/billing/webhook/`
   for the event types from step 3. Configure it for API version
   **2025-03-31.basil**, matching this integration. Use its signing secret.
6. Rebuild the extension against that backend:

   ```powershell
   Set-Location C:\Users\v-naresri\ChromeProject\frontend
   $env:VITE_ACCOUNTS_ENABLED = "true"
   $env:VITE_TOOLS_API_ORIGIN = "https://developer-log-tools-pooja.onrender.com"
   npm.cmd run build:cloud
   Remove-Item Env:\VITE_ACCOUNTS_ENABLED
   Remove-Item Env:\VITE_TOOLS_API_ORIGIN
   ```

7. Test unpacked before publication. With no development key the unpacked cloud
   build has a temporary ID; explicitly allow that ID in backend CORS while
   testing. The store update must target the existing published item.
8. Schedule `python manage.py purge_expired_sessions` daily. Expired tokens
   are denied even before cleanup. Old webhook receipts are purged after 35 days.
9. Configure database backups, edge request/body limits, a shared production
   rate-limit cache, provider-error monitoring without tokens/payloads, and a
   private support/deletion channel before opening accounts publicly.
   Redact `Authorization` headers and OAuth callback query strings from
   proxy/application access logs. Do not enable HTTP-body debug logging.

No Render plan, database, OAuth client, webhook or Stripe account is created
automatically. Do not publish a test-checkout experience as a paid release.
The existing free release package remains account-disabled unless rebuilt
with the explicit flag.

## Verification commands

With account/billing flags unset for the isolated test runner:

```powershell
Set-Location C:\Users\v-naresri\ChromeProject\backend
.\.venv\Scripts\python.exe manage.py test api accounts
.\.venv\Scripts\python.exe manage.py makemigrations --check --dry-run
Set-Location ..\frontend
npm.cmd test
npm.cmd run lint
```

Automated tests mock Google/Stripe network boundaries; they are not proof that
your provider dashboards, real OAuth consent, TLS, webhook deliveries or hosted
checkout are configured correctly. Finish the manual sandbox checklist above.

## Before any real paid launch

Bank payout details are only one remaining requirement. You will also need:
provider eligibility/KYC and business approval; an economical price after
processing/Billing fees; tax handling; terms, refund and cancellation policies;
private support; updated store disclosures/privacy; verified deployment and
backups; real-mode webhook/checkout testing and a deliberate live-mode code change.
Stripe handles payment processing, not automatically all merchant/tax duties.
This code deliberately does not enable that live-mode change.

### References

- [Google OpenID Connect server flow](https://developers.google.com/identity/openid-connect/openid-connect)
- [Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [Stripe subscriptions with Checkout](https://docs.stripe.com/billing/subscriptions/build-subscriptions)
- [Stripe webhook verification and retries](https://docs.stripe.com/events/manage-webhook-endpoints)
