import os
import re
from pathlib import Path

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
    'DEFAULT_THROTTLE_RATES': {'anon': '30/min'},
    # Render's trusted edge supplies X-Forwarded-For; direct local requests do not.
    'NUM_PROXIES': 1 if os.environ.get('DJANGO_TRUST_PROXY') == 'true' else 0,
}

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
