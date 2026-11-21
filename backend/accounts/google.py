from functools import partial

import requests
from django.conf import settings
from google.auth.exceptions import GoogleAuthError
from google.auth.transport.requests import Request
from google.oauth2 import id_token
from rest_framework.exceptions import APIException


class IdentityUnavailable(APIException):
    status_code = 502
    default_detail = 'Google sign-in could not be verified. Start sign-in again.'


def verify_google_code(code, nonce):
    try:
        response = requests.post(
            'https://oauth2.googleapis.com/token',
            data={
                'code': code,
                'client_id': settings.GOOGLE_CLIENT_ID,
                'client_secret': settings.GOOGLE_CLIENT_SECRET,
                'redirect_uri': settings.ACCOUNT_API_ORIGIN + '/api/account/google/callback/',
                'grant_type': 'authorization_code',
            },
            timeout=10,
        )
        response.raise_for_status()
        claims = id_token.verify_oauth2_token(
            response.json()['id_token'],
            partial(Request(), timeout=10),
            settings.GOOGLE_CLIENT_ID,
        )
    except (requests.RequestException, GoogleAuthError, ValueError, KeyError) as error:
        raise IdentityUnavailable() from error
    if (
        claims.get('nonce') != nonce or claims.get('email_verified') is not True
        or not isinstance(claims.get('sub'), str) or not 1 <= len(claims['sub']) <= 255
        or not isinstance(claims.get('email'), str) or len(claims['email']) > 254
        or '@' not in claims['email']
        or claims.get('azp', settings.GOOGLE_CLIENT_ID) != settings.GOOGLE_CLIENT_ID
    ):
        raise IdentityUnavailable()
    return claims
