import logging
from contextlib import contextmanager
from datetime import datetime, timezone as datetime_timezone

import stripe
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import APIException, ValidationError

from .models import Account

logger = logging.getLogger(__name__)
stripe.default_http_client = stripe.RequestsClient(timeout=10)


class BillingUnavailable(APIException):
    status_code = 502
    default_detail = 'Stripe test billing is unavailable. Try again; no access was granted.'


@contextmanager
def stripe_errors():
    try:
        yield
    except stripe.StripeError as error:
        logger.warning('Stripe request failed (%s).', type(error).__name__)
        raise BillingUnavailable() from error


def options():
    if not settings.BILLING_TEST_ENABLED or not settings.STRIPE_SECRET_KEY.startswith('sk_test_'):
        raise ValidationError('Test billing is not configured. Live payments are disabled.')
    return {'api_key': settings.STRIPE_SECRET_KEY, 'stripe_version': settings.STRIPE_API_VERSION}


def validate_price():
    price = stripe.Price.retrieve(settings.STRIPE_PRICE_ID, **options())
    if (
        price.get('livemode') is not False or price.get('active') is not True
        or price.get('currency') != 'usd' or price.get('unit_amount') != 100
        or price.get('type') != 'recurring' or price.get('billing_scheme') != 'per_unit'
        or price.get('recurring', {}).get('interval') != 'month'
        or price.get('recurring', {}).get('interval_count') != 1
        or price.get('recurring', {}).get('usage_type') != 'licensed'
        or price.get('recurring', {}).get('trial_period_days')
    ):
        raise ValidationError('Configure an active TEST Price of exactly $1 USD/month, without a trial.')


def sync_locked(account):
    """Caller holds this account's database lock through the Stripe read and update."""
    status, pro_until = 'none', None
    if account.stripe_customer_id:
        subscriptions = stripe.Subscription.list(
            customer=account.stripe_customer_id, status='all', limit=100,
            expand=['data.latest_invoice'], **options(),
        )
        for subscription in subscriptions.auto_paging_iter():
            if subscription.get('livemode') is not False:
                raise BillingUnavailable()
            items = subscription.get('items', {}).get('data', [])
            matches = [item for item in items if item.get('price', {}).get('id') == settings.STRIPE_PRICE_ID]
            if not matches:
                continue
            invoice = subscription.get('latest_invoice')
            end = max(item.get('current_period_end', 0) for item in matches)
            if (
                subscription.get('status') == 'active' and not subscription.get('pause_collection')
                and isinstance(invoice, dict) and invoice.get('status') == 'paid'
                and end > timezone.now().timestamp()
            ):
                until = datetime.fromtimestamp(end, tz=datetime_timezone.utc)
                pro_until = max(pro_until, until) if pro_until else until
                status = 'active'
            elif pro_until is None:
                status = subscription.get('status', 'none')
    account.pro_until = pro_until
    account.subscription_status = status
    account.save(update_fields=['pro_until', 'subscription_status'])
    return account


def sync_account(account_id):
    with stripe_errors(), transaction.atomic():
        return sync_locked(Account.objects.select_for_update().get(pk=account_id))


def checkout(account_id):
    with stripe_errors(), transaction.atomic():
        validate_price()
        account = Account.objects.select_for_update().get(pk=account_id)
        if not account.stripe_customer_id:
            customer = stripe.Customer.create(
                email=account.email, metadata={'account_id': str(account.id)},
                idempotency_key=f'account-{account.id}', **options(),
            )
            account.stripe_customer_id = customer.id
            account.save(update_fields=['stripe_customer_id'])
        sync_locked(account)
        # A portal visit must resolve an existing subscription, even if its invoice failed.
        subscriptions = stripe.Subscription.list(
            customer=account.stripe_customer_id, status='all', limit=100, **options(),
        )
        subscriptions = list(subscriptions.auto_paging_iter())
        if any(sub.get('status') not in {'canceled', 'incomplete_expired'} for sub in subscriptions):
            raise ValidationError('A test subscription already exists. Use Manage test subscription.')
        old_id = account.checkout_session_id
        if old_id:
            old = stripe.checkout.Session.retrieve(old_id, **options())
            if old.status == 'open':
                return old.url
            if old.status == 'complete' and not subscriptions:
                raise ValidationError('Checkout is complete. Refresh access or use Manage test subscription.')
        session = stripe.checkout.Session.create(
            customer=account.stripe_customer_id, mode='subscription',
            line_items=[{'price': settings.STRIPE_PRICE_ID, 'quantity': 1}],
            payment_method_types=['card'],
            client_reference_id=str(account.id),
            success_url=settings.ACCOUNT_API_ORIGIN + '/api/account/billing/return/',
            cancel_url=settings.ACCOUNT_API_ORIGIN + '/api/account/billing/return/',
            idempotency_key=f'checkout-{account.id}-{old_id or "first"}',
            **options(),
        )
        account.checkout_session_id = session.id
        account.save(update_fields=['checkout_session_id'])
        return session.url


def portal(account):
    if not account.stripe_customer_id:
        raise ValidationError('No test billing customer yet. Start test checkout first.')
    with stripe_errors():
        return stripe.billing_portal.Session.create(
            customer=account.stripe_customer_id,
            return_url=settings.ACCOUNT_API_ORIGIN + '/api/account/billing/return/',
            **options(),
        ).url
