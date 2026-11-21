import os
import re
from pathlib import Path
from urllib.parse import urlsplit

from corsheaders.defaults import default_headers
from django.core.exceptions import ImproperlyConfigured
from django.core.management.utils import get_random_secret_key

BASE_DIR = Path(__file__).resolve().parent.parent
ENVIRONMENT = os.environ.get('DJANGO_ENV', 'development')
if ENVIRONMENT not in {'development', 'production'}:
    raise ImproperlyConfigured('DJANGO_ENV must be development or production.')
IS_PRODUCTION = ENVIRONMENT == 'production'
DEBUG = not IS_PRODUCTION
LOCAL_NOTES_ENABLED = not IS_PRODUCTION
ACCOUNTS_ENABLED = os.environ.get('DJANGO_ACCOUNTS_ENABLED') == 'true'
BILLING_TEST_ENABLED = os.environ.get('DJANGO_BILLING_TEST_ENABLED') == 'true'

SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', '')
if IS_PRODUCTION and (
    len(SECRET_KEY) < 50 or len(set(SECRET_KEY)) < 5
    or SECRET_KEY.startswith('django-insecure-')
):
    raise ImproperlyConfigured('Set a strong DJANGO_SECRET_KEY of at least 50 characters.')
if not SECRET_KEY:
    SECRET_KEY = get_random_secret_key()

ALLOWED_HOSTS = [
    host.strip()
    for host in os.environ.get(
        'DJANGO_ALLOWED_HOSTS', '' if IS_PRODUCTION else '127.0.0.1,localhost',
    ).split(',')
    if host.strip()
]
if IS_PRODUCTION and (
    not ALLOWED_HOSTS or any('*' in host or '://' in host for host in ALLOWED_HOSTS)
):
    raise ImproperlyConfigured('Set DJANGO_ALLOWED_HOSTS to explicit hostnames, without schemes.')

INSTALLED_APPS = [
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.staticfiles',
    'rest_framework',
    'corsheaders',
    'api',
    'accounts',
]
MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]
ROOT_URLCONF = 'config.urls'
WSGI_APPLICATION = 'config.wsgi.application'

# The public tools do not use a database; never publish the local notes file.
DATABASES = {
    'default': {'ENGINE': 'django.db.backends.dummy'}
    if IS_PRODUCTION else {
        'ENGINE': 'django.db.backends.sqlite3',
        'NAME': os.environ.get('DJANGO_SQLITE_PATH', str(BASE_DIR / 'db.sqlite3')),
    },
}
if ACCOUNTS_ENABLED and IS_PRODUCTION:
    import dj_database_url

    database_url = os.environ.get('DATABASE_URL', '')
    if not database_url.startswith(('postgres://', 'postgresql://')):
        raise ImproperlyConfigured('Accounts require a persistent PostgreSQL DATABASE_URL in production.')
    DATABASES['default'] = dj_database_url.parse(
        database_url, conn_max_age=60, conn_health_checks=True, ssl_require=True,
    )
LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True
STATIC_URL = 'static/'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
DATA_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024

CORS_ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        'DJANGO_EXTENSION_ORIGINS',
        '' if IS_PRODUCTION else 'chrome-extension://fhhldfhmeffllcnfcekopdomkcjmekhi',
    ).split(',')
    if origin.strip()
]
if not CORS_ALLOWED_ORIGINS or any(
    not re.fullmatch(r'chrome-extension://[a-p]{32}', origin)
    for origin in CORS_ALLOWED_ORIGINS
):
    raise ImproperlyConfigured('Set DJANGO_EXTENSION_ORIGINS to exact chrome-extension:// IDs.')
CORS_ALLOW_ALL_ORIGINS = False
CORS_ALLOW_CREDENTIALS = False
CORS_ALLOW_HEADERS = [*default_headers, 'x-local-notes', 'x-developer-tools']
CORS_URLS_REGEX = r'^/api/.*$'
REST_FRAMEWORK = {
    'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer'],
    'DEFAULT_THROTTLE_RATES': {'anon': '30/min', 'accounts': '20/min'},
    # Render's trusted edge supplies X-Forwarded-For; direct local requests do not.
    'NUM_PROXIES': 1 if os.environ.get('DJANGO_TRUST_PROXY') == 'true' else 0,
}

ACCOUNT_API_ORIGIN = os.environ.get('DJANGO_PUBLIC_ORIGIN', '')
GOOGLE_CLIENT_ID = os.environ.get('GOOGLE_CLIENT_ID', '')
GOOGLE_CLIENT_SECRET = os.environ.get('GOOGLE_CLIENT_SECRET', '')
STRIPE_SECRET_KEY = os.environ.get('STRIPE_SECRET_KEY', '')
STRIPE_WEBHOOK_SECRET = os.environ.get('STRIPE_WEBHOOK_SECRET', '')
STRIPE_PRICE_ID = os.environ.get('STRIPE_PRICE_ID', '')
STRIPE_API_VERSION = '2025-03-31.basil'
if BILLING_TEST_ENABLED and not ACCOUNTS_ENABLED:
    raise ImproperlyConfigured('Enable accounts before test billing.')
if ACCOUNTS_ENABLED:
    public = urlsplit(ACCOUNT_API_ORIGIN)
    if (
        public.username or public.password or public.query or public.fragment
        or public.path not in {'', '/'} or not public.netloc
        or (public.scheme != 'https' and not (
            not IS_PRODUCTION and public.scheme == 'http' and public.hostname == '127.0.0.1'
        ))
    ):
        raise ImproperlyConfigured('Set DJANGO_PUBLIC_ORIGIN to the external HTTPS API origin (loopback HTTP allowed locally).')
    ACCOUNT_API_ORIGIN = ACCOUNT_API_ORIGIN.rstrip('/')
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise ImproperlyConfigured('Set Google web OAuth client credentials on the server to enable accounts.')
if BILLING_TEST_ENABLED and (
    not STRIPE_SECRET_KEY.startswith('sk_test_')
    or not STRIPE_WEBHOOK_SECRET.startswith('whsec_')
    or not STRIPE_PRICE_ID.startswith('price_')
):
    raise ImproperlyConfigured('Only Stripe TEST keys, a signed webhook secret, and a test Price are supported. Live billing is disabled.')

SECURE_SSL_REDIRECT = IS_PRODUCTION
SESSION_COOKIE_SECURE = IS_PRODUCTION
CSRF_COOKIE_SECURE = IS_PRODUCTION
SECURE_HSTS_SECONDS = 31536000 if IS_PRODUCTION else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = 'DENY'
if os.environ.get('DJANGO_TRUST_PROXY') == 'true':
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
