from datetime import timedelta

from django.core.management.base import BaseCommand
from django.utils import timezone

from accounts.models import AccessSession, BillingEvent, LoginAttempt


class Command(BaseCommand):
    help = 'Delete expired login attempts/sessions and billing event receipts older than 35 days.'

    def handle(self, *args, **options):
        now = timezone.now()
        for model in (AccessSession, LoginAttempt):
            count, _ = model.objects.filter(expires_at__lt=now).delete()
            self.stdout.write(f'{model.__name__}: {count} expired rows removed.')
        count, _ = BillingEvent.objects.filter(processed_at__lt=now - timedelta(days=35)).delete()
        self.stdout.write(f'BillingEvent: {count} old receipts removed.')
