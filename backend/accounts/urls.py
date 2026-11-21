from django.urls import path

from . import views

urlpatterns = [
    path('google/start/', views.GoogleStart.as_view()),
    path('google/callback/', views.GoogleCallback.as_view()),
    path('exchange/', views.ExchangeLogin.as_view()),
    path('me/', views.Me.as_view()),
    path('logout/', views.SignOut.as_view()),
    path('delete/', views.DeleteAccount.as_view()),
    path('billing/checkout/', views.Checkout.as_view()),
    path('billing/portal/', views.Portal.as_view()),
    path('billing/return/', views.billing_return),
    path('billing/webhook/', views.webhook),
]
