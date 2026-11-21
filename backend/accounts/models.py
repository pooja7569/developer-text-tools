import uuid

from django.db import models


class Account(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    google_sub = models.CharField(max_length=255, unique=True)
    email = models.EmailField(max_length=254)
    created_at = models.DateTimeField(auto_now_add=True)
    stripe_customer_id = models.CharField(max_length=255, unique=True, null=True, blank=True)
    checkout_session_id = models.CharField(max_length=255, blank=True)
    subscription_status = models.CharField(max_length=32, default='none')
    pro_until = models.DateTimeField(null=True, blank=True)

    @property
    def is_authenticated(self):
        return True


class LoginAttempt(models.Model):
    state_hash = models.CharField(max_length=64, primary_key=True)
    challenge = models.CharField(max_length=43)
    redirect_uri = models.URLField(max_length=255)
    nonce = models.CharField(max_length=100)
    expires_at = models.DateTimeField(db_index=True)
    consumed = models.BooleanField(default=False)
    ticket_hash = models.CharField(max_length=64, unique=True, null=True)
    account = models.ForeignKey(Account, null=True, on_delete=models.CASCADE)


class AccessSession(models.Model):
    token_hash = models.CharField(max_length=64, primary_key=True)
    account = models.ForeignKey(Account, on_delete=models.CASCADE)
    expires_at = models.DateTimeField(db_index=True)


class BillingEvent(models.Model):
    event_id = models.CharField(max_length=255, primary_key=True)
    processed_at = models.DateTimeField(auto_now_add=True, db_index=True)
