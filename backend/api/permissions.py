from django.conf import settings
from rest_framework.permissions import BasePermission


class LocalNotesRequest(BasePermission):
    message = 'Notes must be accessed through the local extension.'

    def has_permission(self, request, view):
        # A non-simple header forces untrusted websites through CORS preflight.
        # Host-permitted extension requests may omit Origin.
        origin = request.headers.get('Origin')
        return (
            settings.LOCAL_NOTES_ENABLED
            and request.headers.get('X-Local-Notes') == '1'
            and (origin is None or origin in settings.CORS_ALLOWED_ORIGINS)
        )


class ExtensionToolsRequest(BasePermission):
    message = 'Use the developer tools extension to send this request.'

    def has_permission(self, request, view):
        origin = request.headers.get('Origin')
        return (
            request.headers.get('X-Developer-Tools') == '1'
            and (origin is None or origin in settings.CORS_ALLOWED_ORIGINS)
        )
