import hashlib
import re

from django.utils import timezone
from rest_framework.authentication import BaseAuthentication, get_authorization_header
from rest_framework.exceptions import AuthenticationFailed

from .models import AccessSession


def digest(value):
    return hashlib.sha256(value.encode('ascii')).hexdigest()


class AccountAuthentication(BaseAuthentication):
    def authenticate(self, request):
        authorization = get_authorization_header(request)
        if not authorization:
            return None
        if not re.fullmatch(rb'Bearer [A-Za-z0-9_-]{43}', authorization):
            raise AuthenticationFailed('Invalid session. Sign in again.')
        session = AccessSession.objects.select_related('account').filter(
            token_hash=digest(authorization[7:].decode('ascii')), expires_at__gt=timezone.now(),
        ).first()
        if session is None:
            raise AuthenticationFailed('Session expired or revoked. Sign in again.')
        return session.account, session

    def authenticate_header(self, request):
        return 'Bearer'
