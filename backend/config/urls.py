from django.urls import include, path
from django.conf import settings

urlpatterns = [
    path('api/', include('api.urls')),
]
if settings.ACCOUNTS_ENABLED:
    urlpatterns += [path('api/account/', include('accounts.urls'))]
