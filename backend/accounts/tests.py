import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

import requests
import stripe
from django.conf import settings
from django.core.cache import cache
from django.test import SimpleTestCase, TestCase, override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from .authentication import digest
from .billing import BillingUnavailable, checkout
from .google import IdentityUnavailable, verify_google_code
from .models import AccessSession, Account, BillingEvent, LoginAttempt

TEST_SETTINGS = {
    'ROOT_URLCONF': 'accounts.test_urls', 'ACCOUNTS_ENABLED': True,
    'GOOGLE_CLIENT_ID': 'client.apps.googleusercontent.com', 'GOOGLE_CLIENT_SECRET': 'test-client-secret',
    'ACCOUNT_API_ORIGIN': 'http://127.0.0.1:8000',
    'BILLING_TEST_ENABLED': False,
    'STRIPE_SECRET_KEY': 'sk_test_not_a_real_key', 'STRIPE_WEBHOOK_SECRET': 'whsec_test_only',
    'STRIPE_PRICE_ID': 'price_test',
}


def page(items):
    return SimpleNamespace(auto_paging_iter=lambda: iter(items))


def stripe_object(data):
    return stripe.StripeObject.construct_from(data, 'sk_test_not_a_real_key')


class AccountFixture(TestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.account = Account.objects.create(google_sub='google-123', email='person@example.com')
        self.token = 'a' * 43
        self.session = AccessSession.objects.create(
            account=self.account, token_hash=digest(self.token), expires_at=timezone.now() + timedelta(hours=1),
        )

    def login(self):
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + self.token)


@override_settings(**TEST_SETTINGS)
class AccountTests(AccountFixture):
    def test_google_start_rejects_untrusted_redirects_and_malformed_bodies(self):
        redirect = 'https://' + settings.CORS_ALLOWED_ORIGINS[0].removeprefix('chrome-extension://') + '.chromiumapp.org/auth'
        for data in ([], {'challenge': 'a' * 43, 'redirect_uri': []},
                     {'challenge': 'a' * 43, 'redirect_uri': 'https://evil.example/auth'},
                     {'challenge': 'bad', 'redirect_uri': redirect}):
            self.assertEqual(self.client.post('/api/account/google/start/', data, format='json').status_code, 400)
        response = self.client.post('/api/account/google/start/', {'challenge': 'a' * 43, 'redirect_uri': redirect}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response['Cache-Control'], 'no-store')
        query = parse_qs(urlsplit(response.data['url']).query)
        self.assertEqual(query['scope'], ['openid email'])
        self.assertEqual(query['redirect_uri'], ['http://127.0.0.1:8000/api/account/google/callback/'])
        attempt = LoginAttempt.objects.get()
        self.assertNotEqual(attempt.pk, query['state'][0])
        self.assertEqual(attempt.pk, digest(query['state'][0]))

    @patch('accounts.views.verify_google_code')
    def test_oauth_callback_and_pkce_exchange_are_single_use(self, verify):
        verifier = 'x' * 43
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
        attempt = LoginAttempt.objects.create(
            state_hash=digest('s' * 43), challenge=challenge, nonce='nonce',
            redirect_uri='https://test.chromiumapp.org/auth', expires_at=timezone.now() + timedelta(minutes=5),
        )
        verify.return_value = {'sub': self.account.google_sub, 'email': 'updated@example.com'}
        callback = self.client.get('/api/account/google/callback/', {'state': 's' * 43, 'code': 'google-code'})
        self.assertEqual(callback.status_code, 302)
        self.assertEqual(callback['Referrer-Policy'], 'no-referrer')
        ticket = parse_qs(urlsplit(callback['Location']).fragment)['ticket'][0]
        self.assertEqual(self.client.get('/api/account/google/callback/', {'state': 's' * 43, 'code': 'google-code'}).status_code, 400)
        verify.assert_called_once_with('google-code', 'nonce')
        wrong = self.client.post('/api/account/exchange/', {'ticket': ticket, 'verifier': 'z' * 43}, format='json')
        self.assertEqual(wrong.status_code, 400)
        response = self.client.post('/api/account/exchange/', {'ticket': ticket, 'verifier': verifier}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['account']['email'], 'updated@example.com')
        token = response.data['token']
        self.assertTrue(AccessSession.objects.filter(token_hash=digest(token)).exists())
        self.assertFalse(AccessSession.objects.filter(token_hash=token).exists())
        self.assertEqual(self.client.post('/api/account/exchange/', {'ticket': ticket, 'verifier': verifier}, format='json').status_code, 400)
        attempt.refresh_from_db()
        self.assertIsNone(attempt.ticket_hash)

    @patch('accounts.views.verify_google_code')
    def test_expired_state_and_expired_ticket_are_rejected(self, verify):
        LoginAttempt.objects.create(
            state_hash=digest('s' * 43), challenge='a' * 43, nonce='n',
            redirect_uri='https://test.chromiumapp.org/auth',
            expires_at=timezone.now() - timedelta(seconds=1), ticket_hash=digest('t' * 43), account=self.account,
        )
        self.assertEqual(self.client.get('/api/account/google/callback/', {'state': 's' * 43, 'code': 'code'}).status_code, 400)
        self.assertEqual(self.client.post('/api/account/exchange/', {'ticket': 't' * 43, 'verifier': 'a' * 43}, format='json').status_code, 400)
        verify.assert_not_called()

    @patch('accounts.google.id_token.verify_oauth2_token')
    @patch('accounts.google.requests.post')
    def test_google_library_verifies_audience_and_nonce_and_requires_verified_email(self, post, verify):
        post.return_value = Mock(json=lambda: {'id_token': 'signed-token'})
        claims = {'sub': 'google-123', 'email': 'person@example.com', 'email_verified': True, 'nonce': 'expected'}
        verify.return_value = claims
        self.assertEqual(verify_google_code('code', 'expected'), claims)
        self.assertEqual(verify.call_args.args[2], settings.GOOGLE_CLIENT_ID)
        self.assertEqual(post.call_args.kwargs['timeout'], 10)
        for bad in ({**claims, 'nonce': 'wrong'}, {**claims, 'email_verified': False}, {**claims, 'azp': 'other-client'}):
            verify.return_value = bad
            with self.assertRaises(IdentityUnavailable):
                verify_google_code('code', 'expected')
        verify.side_effect = ValueError('signature invalid')
        with self.assertRaises(IdentityUnavailable):
            verify_google_code('code', 'expected')
        post.side_effect = requests.Timeout()
        with self.assertRaises(IdentityUnavailable):
            verify_google_code('code', 'expected')

    def test_session_auth_expiry_revocation_and_no_tokens_in_account_response(self):
        self.assertEqual(self.client.get('/api/account/me/').status_code, 401)
        self.login()
        response = self.client.get('/api/account/me/')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.data['pro'])
        self.assertNotIn(self.token, response.content.decode())
        self.assertEqual(self.client.post('/api/account/logout/', {}, format='json').status_code, 204)
        self.assertEqual(self.client.get('/api/account/me/').status_code, 401)
        AccessSession.objects.create(account=self.account, token_hash=digest(self.token), expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.client.get('/api/account/me/').status_code, 401)

    def test_billing_disabled_and_return_page_never_grants_access(self):
        self.login()
        self.assertEqual(self.client.post('/api/account/billing/checkout/', {}, format='json').status_code, 400)
        self.assertEqual(self.client.post('/api/account/billing/webhook/', {}, format='json').status_code, 503)
        self.assertContains(self.client.get('/api/account/billing/return/'), 'does not grant Pro access')
        self.account.refresh_from_db()
        self.assertIsNone(self.account.pro_until)

    def test_account_deletion_requires_confirmation_and_revokes_sessions(self):
        self.login()
        self.assertEqual(self.client.post('/api/account/delete/', {}, format='json').status_code, 400)
        self.assertEqual(self.client.post('/api/account/delete/', {'confirmation': 'DELETE'}, format='json').status_code, 204)
        self.assertFalse(Account.objects.filter(pk=self.account.pk).exists())
        self.assertFalse(AccessSession.objects.exists())
        self.assertEqual(self.client.get('/api/account/me/').status_code, 401)


@override_settings(**{**TEST_SETTINGS, 'BILLING_TEST_ENABLED': True})
class BillingTests(AccountFixture):
    def setUp(self):
        super().setUp()
        self.login()
        self.account.stripe_customer_id = 'cus_test'
        self.account.save()
        self.end = int((timezone.now() + timedelta(days=30)).timestamp())

    def active_subscription(self, **overrides):
        return {
            'id': 'sub_test', 'livemode': False, 'status': 'active', 'customer': 'cus_test',
            'items': {'data': [{'price': {'id': 'price_test'}, 'current_period_end': self.end}]},
            'latest_invoice': {'status': 'paid'}, **overrides,
        }

    def post_event(self, event, secret='whsec_test_only', timestamp=None):
        payload = json.dumps(event).encode()
        timestamp = int(time.time()) if timestamp is None else timestamp
        signature = hmac.new(secret.encode(), str(timestamp).encode() + b'.' + payload, hashlib.sha256).hexdigest()
        return self.client.post(
            '/api/account/billing/webhook/', payload, content_type='application/json',
            HTTP_STRIPE_SIGNATURE=f't={timestamp},v1={signature}',
        )

    @patch('accounts.billing.stripe.Subscription.list')
    def test_entitlements_follow_authoritative_subscription_not_redirect_or_event_payload(self, subscriptions):
        subscriptions.return_value = page([self.active_subscription()])
        response = self.client.get('/api/account/me/')
        self.assertTrue(response.data['pro'])
        event = {'id': 'evt_old', 'type': 'customer.subscription.updated', 'livemode': False,
                 'data': {'object': self.active_subscription()}}
        subscriptions.return_value = page([self.active_subscription(status='canceled')])
        self.assertEqual(self.post_event(event).status_code, 200)
        self.account.refresh_from_db()
        self.assertIsNone(self.account.pro_until)
        self.assertEqual(self.account.subscription_status, 'canceled')
        subscriptions.reset_mock()
        self.assertEqual(self.post_event(event).status_code, 200)
        subscriptions.assert_not_called()

    @patch('accounts.billing.stripe.Subscription.list')
    def test_payment_failures_wrong_prices_unpaid_invoices_and_live_subscriptions_never_grant_pro(self, subscriptions):
        for subscription in [
            self.active_subscription(status='past_due'),
            self.active_subscription(latest_invoice={'status': 'open'}),
            self.active_subscription(items={'data': [{'price': {'id': 'price_other'}, 'current_period_end': self.end}]}),
            self.active_subscription(items={'data': [{'price': {'id': 'price_test'}, 'current_period_end': 1}]}),
        ]:
            subscriptions.return_value = page([subscription])
            self.assertFalse(self.client.get('/api/account/me/').data['pro'])
        subscriptions.return_value = page([self.active_subscription(livemode=True)])
        self.assertEqual(self.client.get('/api/account/me/').status_code, 502)

    @patch('accounts.billing.stripe.Subscription.list')
    def test_bad_webhook_signatures_live_events_and_unknown_customers_are_rejected_or_ignored(self, subscriptions):
        event = {'id': 'evt_test', 'type': 'invoice.paid', 'livemode': False, 'data': {'object': {'customer': 'cus_test'}}}
        self.assertEqual(self.post_event(event, secret='wrong').status_code, 400)
        self.assertEqual(self.post_event(event, timestamp=1).status_code, 400)
        self.assertEqual(self.post_event({**event, 'livemode': True}).status_code, 400)
        self.assertEqual(self.post_event({**event, 'data': {'object': {'customer': 'cus_unknown'}}}).status_code, 200)
        subscriptions.assert_not_called()
        self.assertEqual(BillingEvent.objects.count(), 0)

    @patch('accounts.billing.stripe.Subscription.list')
    def test_failed_webhook_is_retryable_and_does_not_record_success(self, subscriptions):
        subscriptions.side_effect = stripe.APIConnectionError('network')
        event = {'id': 'evt_retry', 'type': 'invoice.paid', 'livemode': False, 'data': {'object': {'customer': 'cus_test'}}}
        self.assertEqual(self.post_event(event).status_code, 502)
        self.assertFalse(BillingEvent.objects.filter(pk='evt_retry').exists())
        subscriptions.side_effect = None
        subscriptions.return_value = page([self.active_subscription()])
        self.assertEqual(self.post_event(event).status_code, 200)
        self.assertTrue(BillingEvent.objects.filter(pk='evt_retry').exists())

    @patch('accounts.billing.stripe.checkout.Session.create')
    @patch('accounts.billing.stripe.checkout.Session.retrieve')
    @patch('accounts.billing.stripe.Price.retrieve')
    @patch('accounts.billing.stripe.Subscription.list')
    def test_checkout_is_fixed_price_and_reuses_open_session(self, subscriptions, price, retrieve, create):
        subscriptions.return_value = page([])
        price.return_value = {
            'active': True, 'livemode': False, 'currency': 'usd', 'unit_amount': 100,
            'type': 'recurring', 'billing_scheme': 'per_unit',
            'recurring': {'interval': 'month', 'interval_count': 1, 'usage_type': 'licensed'},
        }
        create.return_value = stripe_object({'id': 'cs_test', 'url': 'https://checkout.stripe.com/c/pay/cs_test'})
        first = self.client.post('/api/account/billing/checkout/', {'price': 'attacker-price', 'customer': 'other'}, format='json')
        self.assertEqual(first.status_code, 200)
        self.assertEqual(create.call_args.kwargs['line_items'], [{'price': 'price_test', 'quantity': 1}])
        self.assertEqual(create.call_args.kwargs['customer'], 'cus_test')
        retrieve.return_value = stripe_object({'status': 'open', 'url': 'https://checkout.stripe.com/c/pay/cs_test'})
        self.assertEqual(self.client.post('/api/account/billing/checkout/', {}, format='json').status_code, 200)
        create.assert_called_once()
        subscriptions.return_value = page([self.active_subscription(status='past_due')])
        self.assertEqual(self.client.post('/api/account/billing/checkout/', {}, format='json').status_code, 400)
        subscriptions.return_value = page([self.active_subscription(status='canceled')])
        retrieve.return_value = stripe_object({'status': 'complete'})
        self.assertEqual(self.client.post('/api/account/billing/checkout/', {}, format='json').status_code, 200)
        self.assertEqual(create.call_count, 2)

    @patch('accounts.billing.stripe.Price.retrieve')
    def test_live_keys_and_wrong_price_are_blocked(self, price):
        with override_settings(STRIPE_SECRET_KEY='sk_live_forbidden'):
            with self.assertRaisesMessage(Exception, 'Live payments are disabled'):
                checkout(self.account.pk)
        price.assert_not_called()
        price.return_value = {'livemode': True}
        self.assertEqual(self.client.post('/api/account/billing/checkout/', {}, format='json').status_code, 400)

    @patch('accounts.billing.stripe.billing_portal.Session.create')
    def test_portal_uses_only_authenticated_customer(self, create):
        create.return_value = stripe_object({'url': 'https://billing.stripe.com/p/session/test'})
        response = self.client.post('/api/account/billing/portal/', {'customer': 'someone-else'}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(create.call_args.kwargs['customer'], 'cus_test')

    @patch('accounts.views.stripe.Customer.delete')
    def test_delete_cancels_only_own_test_customer_and_keeps_account_on_provider_error(self, delete):
        delete.side_effect = stripe.APIConnectionError('network')
        self.assertEqual(self.client.post('/api/account/delete/', {'confirmation': 'DELETE'}, format='json').status_code, 502)
        self.assertTrue(Account.objects.filter(pk=self.account.pk).exists())
        delete.side_effect = None
        self.assertEqual(self.client.post('/api/account/delete/', {'confirmation': 'DELETE', 'customer': 'someone-else'}, format='json').status_code, 204)
        self.assertEqual(delete.call_args.args, ('cus_test',))
        self.assertFalse(Account.objects.filter(pk=self.account.pk).exists())


class AccountConfigurationTests(SimpleTestCase):
    def run_settings(self, **overrides):
        env = {
            key: value for key, value in os.environ.items()
            if not key.startswith(('DJANGO_', 'GOOGLE_', 'STRIPE_')) and key != 'DATABASE_URL'
        }
        env.update({
            'DJANGO_SETTINGS_MODULE': 'config.settings', 'DJANGO_ENV': 'production',
            'DJANGO_SECRET_KEY': 'test-only-not-a-deployment-secret-' * 3,
            'DJANGO_ALLOWED_HOSTS': 'tools.example.com',
            'DJANGO_EXTENSION_ORIGINS': settings.CORS_ALLOWED_ORIGINS[0],
            'DJANGO_ACCOUNTS_ENABLED': 'true', 'DJANGO_BILLING_TEST_ENABLED': 'true',
            'DJANGO_PUBLIC_ORIGIN': 'https://tools.example.com',
            'DATABASE_URL': 'postgresql://test:test@localhost:5432/test',
            'GOOGLE_CLIENT_ID': 'test-client', 'GOOGLE_CLIENT_SECRET': 'test-secret',
            'STRIPE_SECRET_KEY': 'sk_test_not_a_real_key', 'STRIPE_WEBHOOK_SECRET': 'whsec_test',
            'STRIPE_PRICE_ID': 'price_test', **overrides,
        })
        return subprocess.run(
            [sys.executable, '-c',
             'import django; django.setup(); from django.conf import settings; '
             'assert settings.DATABASES["default"]["ENGINE"] == "django.db.backends.postgresql"; '
             'assert settings.DATABASES["default"]["OPTIONS"]["sslmode"] == "require"; '
             'assert not settings.LOCAL_NOTES_ENABLED; '
             'from django.urls import resolve; resolve("/api/account/me/")'],
            cwd=settings.BASE_DIR, env=env, capture_output=True, text=True, timeout=30,
        )

    def test_account_production_requires_postgres_https_and_test_only_keys(self):
        valid = self.run_settings()
        self.assertEqual(valid.returncode, 0, valid.stderr)
        for overrides in (
            {'DATABASE_URL': 'sqlite:///db.sqlite3'},
            {'DJANGO_PUBLIC_ORIGIN': 'http://tools.example.com'},
            {'GOOGLE_CLIENT_SECRET': ''},
            {'STRIPE_SECRET_KEY': 'sk_live_forbidden'},
            {'DJANGO_ACCOUNTS_ENABLED': 'false'},
        ):
            result = self.run_settings(**overrides)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('ImproperlyConfigured', result.stderr)
