from django.conf import settings
from django.urls import path

from .views import NoteDetailView, NotesImportView, NotesView, greet, log_to_csv_view

urlpatterns = [
    path('greet/', greet, name='greet'),
    path('log-to-csv/', log_to_csv_view, name='log-to-csv'),
]
if settings.LOCAL_NOTES_ENABLED:
    urlpatterns += [
        path('notes/', NotesView.as_view(), name='notes'),
        path('notes/import/', NotesImportView.as_view(), name='notes-import'),
        path('notes/<int:pk>/', NoteDetailView.as_view(), name='note-detail'),
    ]
