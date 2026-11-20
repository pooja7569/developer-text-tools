import base64
import hashlib
import logging
import re
import secrets
from datetime import timedelta
from urllib.parse import urlencode

import stripe
from django.conf import settings
from django.db import transaction
from django.http import HttpResponse, HttpResponseRedirect, JsonResponse
from django.utils import timezone
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.debug import sensitive_post_parameters
from django.views.decorators.http import require_POST
from rest_framework.exceptions import ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.parsers import JSONParser
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from . import billing
from .authentication import AccountAuthentication, digest
from .google import verify_google_code
from .models import AccessSession, Account, BillingEvent, LoginAttempt

logger = logging.getLogger(__name__)


def private(response):
    response['Cache-Control'] = 'no-store'
    response['Referrer-Policy'] = 'no-referrer'
    return response


def account_data(account):
    return {
        'email': account.email,
        'pro': bool(settings.BILLING_TEST_ENABLED and account.pro_until and account.pro_until > timezone.now()),
        'pro_until': account.pro_until.isoformat() if account.pro_until else None,
        'subscription_status': account.subscription_status,
        'billing_mode': 'test' if settings.BILLING_TEST_ENABLED else 'disabled',
    }


class AccountView(APIView):
    authentication_classes = [AccountAuthentication]
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = 'accounts'
    parser_classes = [JSONParser]

    def initial(self, request, *args, **kwargs):
        if not settings.ACCOUNTS_ENABLED:
            raise ValidationError('Accounts are disabled.')
        super().initial(request, *args, **kwargs)
        if request.method == 'POST' and not isinstance(request.data, dict):
            raise ValidationError('Expected a JSON object.')

    def finalize_response(self, request, response, *args, **kwargs):
        return private(super().finalize_response(request, response, *args, **kwargs))


class GoogleStart(AccountView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        challenge = request.data.get('challenge')
        redirect_uri = request.data.get('redirect_uri')
        allowed_redirects = {
            f'https://{origin.removeprefix("chrome-extension://")}.chromiumapp.org/auth'
            for origin in settings.CORS_ALLOWED_ORIGINS
        }
        if not isinstance(challenge, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', challenge) or not isinstance(redirect_uri, str) or redirect_uri not in allowed_redirects:
            raise ValidationError('Invalid login challenge or extension redirect URI.')
        state = secrets.token_urlsafe(32)
        nonce = secrets.token_urlsafe(32)
        LoginAttempt.objects.create(
            state_hash=digest(state), challenge=challenge, redirect_uri=redirect_uri,
            nonce=nonce, expires_at=timezone.now() + timedelta(minutes=10),
        )
        return Response({'url': 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode({
            'client_id': settings.GOOGLE_CLIENT_ID,
            'redirect_uri': settings.ACCOUNT_API_ORIGIN + '/api/account/google/callback/',
            'response_type': 'code', 'scope': 'openid email',
            'state': state, 'nonce': nonce, 'prompt': 'select_account',
        })})


class GoogleCallback(AccountView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = []

    def get(self, request):
        state = request.query_params.get('state', '')
        code = request.query_params.get('code', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43}', state) or not code or len(code) > 4096:
            raise ValidationError('Google sign-in was cancelled or invalid. Close this window and try again.')
        attempt = LoginAttempt.objects.filter(
            state_hash=digest(state), consumed=False, expires_at__gt=timezone.now(),
        ).first()
        if attempt is None or not LoginAttempt.objects.filter(pk=attempt.pk, consumed=False).update(consumed=True):
            raise ValidationError('Sign-in expired or already used. Start again.')
        claims = verify_google_code(code, attempt.nonce)
        # Google subject, not a mutable email address, is the account identity.
        account, _ = Account.objects.update_or_create(
            google_sub=claims['sub'], defaults={'email': claims['email']},
        )
        ticket = secrets.token_urlsafe(32)
        attempt.account = account
        attempt.ticket_hash = digest(ticket)
        attempt.expires_at = timezone.now() + timedelta(seconds=60)
        attempt.save(update_fields=['account', 'ticket_hash', 'expires_at'])
        return private(HttpResponseRedirect(attempt.redirect_uri + '#' + urlencode({'ticket': ticket})))


class ExchangeLogin(AccountView):
    authentication_classes = []
    permission_classes = [AllowAny]

    def post(self, request):
        ticket = request.data.get('ticket')
        verifier = request.data.get('verifier')
        if not isinstance(ticket, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', ticket) or not isinstance(verifier, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', verifier):
            raise ValidationError('Invalid login exchange.')
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode('ascii')).digest()).decode('ascii').rstrip('=')
        with transaction.atomic():
            attempt = LoginAttempt.objects.filter(
                ticket_hash=digest(ticket), challenge=challenge,
                expires_at__gt=timezone.now(), account__isnull=False,
            ).first()
            if attempt is None or not LoginAttempt.objects.filter(pk=attempt.pk, ticket_hash=digest(ticket)).update(ticket_hash=None):
                raise ValidationError('Login expired, already used, or belongs to another browser flow.')
            token = secrets.token_urlsafe(32)
            expires = timezone.now() + timedelta(hours=12)
            AccessSession.objects.create(token_hash=digest(token), account=attempt.account, expires_at=expires)
        return Response({'token': token, 'expires_at': expires.isoformat(), 'account': account_data(attempt.account)})


class Me(AccountView):
    def get(self, request):
        account = billing.sync_account(request.user.pk) if settings.BILLING_TEST_ENABLED else request.user
        return Response(account_data(account))


class SignOut(AccountView):
    def post(self, request):
        request.auth.delete()
        return Response(status=204)


class DeleteAccount(AccountView):
    def post(self, request):
        if request.data.get('confirmation') != 'DELETE':
            raise ValidationError('Explicit account deletion confirmation is required.')
        with billing.stripe_errors(), transaction.atomic():
            account = Account.objects.select_for_update().get(pk=request.user.pk)
            if account.stripe_customer_id:
                # Deleting a Stripe customer cancels its test subscriptions.
                stripe.Customer.delete(account.stripe_customer_id, **billing.options())
            account.delete()
        return Response(status=204)


class Checkout(AccountView):
    def post(self, request):
        return Response({'url': billing.checkout(request.user.pk)})


class Portal(AccountView):
    def post(self, request):
        return Response({'url': billing.portal(request.user)})


def billing_return(request):
    return private(HttpResponse(
        'Stripe test session finished. No real payment was taken. '
        'Return to DevToolBox and click Refresh account/access. '
        'This page does not grant Pro access.',
        content_type='text/plain',
    ))


@csrf_exempt
@sensitive_post_parameters()
@require_POST
def webhook(request):
    if not settings.BILLING_TEST_ENABLED:
        return private(JsonResponse({'detail': 'Test billing is disabled.'}, status=503))
    if len(request.body) > 1024 * 1024:
        return private(JsonResponse({'detail': 'Webhook too large.'}, status=413))
    try:
        event = stripe.Webhook.construct_event(
            request.body, request.headers.get('Stripe-Signature', ''), settings.STRIPE_WEBHOOK_SECRET,
        )
    except (ValueError, stripe.SignatureVerificationError):
        logger.warning('Rejected invalid Stripe webhook signature or body.')
        return private(JsonResponse({'detail': 'Invalid webhook signature or body.'}, status=400))
    if event.get('livemode') is not False:
        return private(JsonResponse({'detail': 'Live events are not supported.'}, status=400))
    if event.get('type') not in {
        'checkout.session.completed', 'checkout.session.async_payment_succeeded',
        'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
        'invoice.paid', 'invoice.payment_failed',
    }:
        return private(JsonResponse({'received': True}))
    customer_id = event['data']['object'].get('customer')
    with transaction.atomic():
        account = Account.objects.select_for_update().filter(stripe_customer_id=customer_id).first() if customer_id else None
        if account is None or BillingEvent.objects.filter(pk=event.id).exists():
            return private(JsonResponse({'received': True}))
        try:
            with billing.stripe_errors():
                billing.sync_locked(account)
        except billing.BillingUnavailable:
            return private(JsonResponse({'detail': 'Reconciliation failed; retry event delivery.'}, status=502))
        BillingEvent.objects.create(event_id=event.id)
    return private(JsonResponse({'received': True}))
