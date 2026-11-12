import base64
import hashlib
import json
from unittest.mock import patch

from django.conf import settings
from django.db import IntegrityError
from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient

from .models import Note


class GreetingTests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()

    def test_returns_exact_greeting(self):
        response = self.client.get('/api/greet/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {'message': 'Hello from your Django backend!'},
        )

    def test_allows_extension_origin(self):
        origin = settings.CORS_ALLOWED_ORIGINS[0]
        response = self.client.get('/api/greet/', HTTP_ORIGIN=origin)

        self.assertEqual(response.headers['Access-Control-Allow-Origin'], origin)
        self.assertNotIn('Access-Control-Allow-Credentials', response.headers)

    def test_does_not_allow_unlisted_origins(self):
        for origin in (
            'https://example.com',
            'chrome-extension://' + 'a' * 32,
        ):
            with self.subTest(origin=origin):
                response = self.client.get('/api/greet/', HTTP_ORIGIN=origin)
                self.assertNotIn('Access-Control-Allow-Origin', response.headers)

    def test_handles_preflight(self):
        origin = settings.CORS_ALLOWED_ORIGINS[0]
        response = self.client.options(
            '/api/greet/',
            HTTP_ORIGIN=origin,
            HTTP_ACCESS_CONTROL_REQUEST_METHOD='GET',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Access-Control-Allow-Origin'], origin)

    def test_rejects_post(self):
        response = self.client.post('/api/greet/', {}, format='json')
        self.assertEqual(response.status_code, 405)

    def test_manifest_key_matches_allowed_origin(self):
        manifest_path = (
            settings.BASE_DIR.parent / 'frontend' / 'public' / 'manifest.json'
        )
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        digest = hashlib.sha256(base64.b64decode(manifest['key'])).hexdigest()[:32]
        extension_id = ''.join(chr(ord('a') + int(char, 16)) for char in digest)

        self.assertEqual(
            settings.CORS_ALLOWED_ORIGINS,
            [f'chrome-extension://{extension_id}'],
        )


class NotesTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.client.credentials(
            HTTP_X_LOCAL_NOTES='1',
            HTTP_ORIGIN=settings.CORS_ALLOWED_ORIGINS[0],
        )

    def test_empty_list(self):
        response = self.client.get('/api/notes/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [])

    def test_creates_and_lists_notes_newest_first(self):
        first = self.client.post(
            '/api/notes/', {'text': '  First note  '}, format='json',
        )
        second = self.client.post(
            '/api/notes/', {'text': 'Second\nnote'}, format='json',
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertEqual(first.json()['text'], 'First note')
        self.assertEqual(set(first.json()), {'id', 'text', 'created_at'})
        self.assertTrue(first.json()['created_at'])
        self.assertEqual(Note.objects.count(), 2)

        # A separate client reads the database, not transient client state.
        reader = APIClient()
        response = reader.get('/api/notes/', HTTP_X_LOCAL_NOTES='1')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), [second.json(), first.json()])

    def test_rejects_invalid_notes_without_saving(self):
        for data in ({}, {'text': ''}, {'text': ' \n '}, {'text': None},
                     {'text': 'a' * 2001}):
            with self.subTest(data=data):
                response = self.client.post('/api/notes/', data, format='json')
                self.assertEqual(response.status_code, 400)
                self.assertIn('text', response.json())
        self.assertEqual(Note.objects.count(), 0)

    def test_accepts_exact_maximum_length(self):
        response = self.client.post(
            '/api/notes/', {'text': 'a' * 2000}, format='json',
        )
        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(response.json()['text']), 2000)

    def test_rejects_simple_and_untrusted_requests(self):
        for headers in (
            {},
            {'HTTP_ORIGIN': settings.CORS_ALLOWED_ORIGINS[0]},
            {'HTTP_X_LOCAL_NOTES': '1', 'HTTP_ORIGIN': 'https://example.com'},
        ):
            with self.subTest(headers=headers):
                client = APIClient()
                response = client.post(
                    '/api/notes/', {'text': 'Blocked'}, format='json', **headers,
                )
                self.assertEqual(response.status_code, 403)
                self.assertEqual(
                    client.get('/api/notes/', **headers).status_code, 403,
                )
        self.assertEqual(Note.objects.count(), 0)

    def test_allows_json_post_preflight(self):
        response = self.client.options(
            '/api/notes/',
            HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST',
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS='content-type,x-local-notes',
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers['Access-Control-Allow-Origin'],
            settings.CORS_ALLOWED_ORIGINS[0],
        )
        self.assertIn('x-local-notes', response.headers['Access-Control-Allow-Headers'])

    def test_rejects_form_posts(self):
        response = self.client.post('/api/notes/', {'text': 'Not JSON'})
        self.assertEqual(response.status_code, 415)
        self.assertEqual(Note.objects.count(), 0)

    def test_edits_only_target_note_and_preserves_creation_time(self):
        note = Note.objects.create(text='Original')
        other = Note.objects.create(text='Unchanged')
        created_at = note.created_at
        response = self.client.patch(
            f'/api/notes/{note.pk}/',
            {'text': '  Edited\nnote  ', 'id': 999, 'created_at': 'invalid'},
            format='json',
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['text'], 'Edited\nnote')
        self.assertEqual(response.json()['id'], note.pk)
        note.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual(note.text, 'Edited\nnote')
        self.assertEqual(note.created_at, created_at)
        self.assertEqual(other.text, 'Unchanged')

    def test_edit_validates_length_and_keeps_original_on_failure(self):
        note = Note.objects.create(text='Original')
        for text in ('', ' \n ', None, 'a' * 2001):
            with self.subTest(text=text):
                response = self.client.patch(
                    f'/api/notes/{note.pk}/', {'text': text}, format='json',
                )
                self.assertEqual(response.status_code, 400)
                self.assertIn('text', response.json())
                note.refresh_from_db()
                self.assertEqual(note.text, 'Original')
        response = self.client.patch(
            f'/api/notes/{note.pk}/', {'text': 'a' * 2000}, format='json',
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()['text']), 2000)

    def test_deletes_only_target_note(self):
        note = Note.objects.create(text='Delete me')
        other = Note.objects.create(text='Keep me')
        response = self.client.delete(f'/api/notes/{note.pk}/')

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.content, b'')
        self.assertFalse(Note.objects.filter(pk=note.pk).exists())
        self.assertTrue(Note.objects.filter(pk=other.pk).exists())
        self.assertEqual(self.client.get('/api/notes/').json()[0]['id'], other.pk)

    def test_missing_notes_return_404(self):
        for method in ('patch', 'delete'):
            response = getattr(self.client, method)(
                '/api/notes/99999/', {'text': 'Missing'}, format='json',
            )
            self.assertEqual(response.status_code, 404)

    def test_detail_rejects_untrusted_requests(self):
        note = Note.objects.create(text='Original')
        for headers in (
            {},
            {'HTTP_X_LOCAL_NOTES': '1', 'HTTP_ORIGIN': 'https://example.com'},
        ):
            for method in ('patch', 'delete'):
                client = APIClient()
                response = getattr(client, method)(
                    f'/api/notes/{note.pk}/',
                    {'text': 'Blocked'}, format='json', **headers,
                )
                self.assertEqual(response.status_code, 403)
        note.refresh_from_db()
        self.assertEqual(note.text, 'Original')

    def test_detail_preflight_allows_patch_and_delete(self):
        for method in ('PATCH', 'DELETE'):
            response = self.client.options(
                '/api/notes/1/',
                HTTP_ACCESS_CONTROL_REQUEST_METHOD=method,
                HTTP_ACCESS_CONTROL_REQUEST_HEADERS='content-type,x-local-notes',
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                response.headers['Access-Control-Allow-Origin'],
                settings.CORS_ALLOWED_ORIGINS[0],
            )
            self.assertIn(method, response.headers['Access-Control-Allow-Methods'])

    def test_detail_rejects_form_edits_and_put(self):
        note = Note.objects.create(text='Original')
        response = self.client.patch(
            f'/api/notes/{note.pk}/', {'text': 'Form edit'}, format='multipart',
        )
        self.assertEqual(response.status_code, 415)
        response = self.client.put(
            f'/api/notes/{note.pk}/', {'text': 'Put edit'}, format='json',
        )
        self.assertEqual(response.status_code, 405)


class NotesImportTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.client.credentials(
            HTTP_X_LOCAL_NOTES='1',
            HTTP_ORIGIN=settings.CORS_ALLOWED_ORIGINS[0],
        )

    def backup(self, texts):
        return {
            'version': 1,
            'exported_at': '2026-11-10T10:00:00Z',
            'notes': [
                {'id': index + 100, 'text': text, 'created_at': '2020-01-01T00:00:00Z'}
                for index, text in enumerate(texts)
            ],
        }

    def test_import_adds_notes_and_skips_duplicate_trimmed_text(self):
        existing = Note.objects.create(text='Keep me')
        original_time = existing.created_at
        backup = self.backup(['Keep me', '  New note  ', 'New note', 'keep me'])
        response = self.client.post('/api/notes/import/', backup, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['imported'], 2)
        self.assertEqual(response.json()['skipped'], 2)
        self.assertEqual(Note.objects.count(), 3)
        existing.refresh_from_db()
        self.assertEqual(existing.text, 'Keep me')
        self.assertEqual(existing.created_at, original_time)
        created = Note.objects.get(text='New note')
        self.assertNotEqual(created.pk, backup['notes'][1]['id'])
        self.assertNotEqual(created.created_at.year, 2020)
        self.assertEqual(
            response.json()['notes'], self.client.get('/api/notes/').json(),
        )
        repeated = self.client.post('/api/notes/import/', backup, format='json')
        self.assertEqual(repeated.json()['imported'], 0)
        self.assertEqual(repeated.json()['skipped'], 4)
        self.assertEqual(Note.objects.count(), 3)

    def test_empty_backup_keeps_existing_notes(self):
        Note.objects.create(text='Keep')
        response = self.client.post(
            '/api/notes/import/', self.backup([]), format='json',
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['imported'], 0)
        self.assertEqual(response.json()['skipped'], 0)
        self.assertEqual(Note.objects.count(), 1)

    def test_invalid_entry_rejects_entire_backup(self):
        Note.objects.create(text='Keep')
        for invalid in ('', ' \n ', None, 42, 'a' * 2001):
            with self.subTest(invalid=invalid):
                response = self.client.post(
                    '/api/notes/import/', self.backup(['Valid', invalid]), format='json',
                )
                self.assertEqual(response.status_code, 400)
                self.assertEqual(list(Note.objects.values_list('text', flat=True)), ['Keep'])

    def test_rejects_invalid_format_and_metadata(self):
        for data in (
            {}, [], {'version': 2}, {**self.backup([]), 'notes': {}},
            {**self.backup([]), 'exported_at': 'invalid'},
            {**self.backup([]), 'version': True},
            {**self.backup([]), 'version': '1'},
        ):
            with self.subTest(data=data):
                response = self.client.post('/api/notes/import/', data, format='json')
                self.assertEqual(response.status_code, 400)
        for field, invalid in (
            ('id', 0), ('id', '1'), ('id', True), ('id', 9007199254740992),
            ('created_at', 'invalid'),
        ):
            data = self.backup(['Valid'])
            data['notes'][0][field] = invalid
            response = self.client.post('/api/notes/import/', data, format='json')
            self.assertEqual(response.status_code, 400)
        self.assertEqual(Note.objects.count(), 0)

    def test_enforces_exact_note_and_text_limits(self):
        data = self.backup([str(index) for index in range(500)])
        data['notes'][0]['text'] = 'a' * 2000
        response = self.client.post('/api/notes/import/', data, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['imported'], 500)
        response = self.client.post(
            '/api/notes/import/', self.backup(['x'] * 501), format='json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Note.objects.count(), 500)

    def test_enforces_exact_byte_limit(self):
        body = json.dumps(self.backup([]))
        body += ' ' * (1024 * 1024 - len(body.encode('utf-8')))
        response = self.client.post(
            '/api/notes/import/', body, content_type='application/json',
        )
        self.assertEqual(response.status_code, 200)
        response = self.client.post(
            '/api/notes/import/', body + ' ', content_type='application/json',
        )
        self.assertEqual(response.status_code, 413)
        self.assertEqual(Note.objects.count(), 0)

    def test_import_rejects_untrusted_origins_and_form_data(self):
        client = APIClient()
        for headers in (
            {},
            {'HTTP_X_LOCAL_NOTES': '1', 'HTTP_ORIGIN': 'https://example.com'},
        ):
            response = client.post(
                '/api/notes/import/', self.backup(['Blocked']), format='json', **headers,
            )
            self.assertEqual(response.status_code, 403)
        response = self.client.post('/api/notes/import/', {'version': 1})
        self.assertEqual(response.status_code, 415)
        self.assertEqual(Note.objects.count(), 0)

    def test_bad_json_does_not_save_notes(self):
        response = self.client.post(
            '/api/notes/import/', '{bad json', content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)
        self.assertEqual(Note.objects.count(), 0)

    def test_database_failure_rolls_back_the_whole_import(self):
        Note.objects.create(text='Keep')

        def partial_failure(notes):
            notes[0].save()
            raise IntegrityError('Simulated database failure')

        with patch.object(Note.objects, 'bulk_create', side_effect=partial_failure):
            with self.assertRaises(IntegrityError):
                self.client.post(
                    '/api/notes/import/', self.backup(['New one', 'New two']), format='json',
                )
        self.assertEqual(list(Note.objects.values_list('text', flat=True)), ['Keep'])
