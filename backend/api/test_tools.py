import csv
import io
import json
import os
import subprocess
import sys

from django.conf import settings
from django.core.cache import cache
from django.test import SimpleTestCase, override_settings
from rest_framework.test import APIClient

from .log_parser import logs_to_csv


class LogParserTests(SimpleTestCase):
    def rows(self, text):
        return list(csv.DictReader(io.StringIO(logs_to_csv(text))))

    def test_key_value_dynamic_columns_and_quoted_values(self):
        rows = self.rows(
            '2026-11-10 INFO level=info message="Hello, world" duration=12\n'
            'level=error user=alice'
        )
        self.assertEqual(rows[0]['_prefix'], '2026-11-10 INFO')
        self.assertEqual(rows[0]['message'], 'Hello, world')
        self.assertEqual(rows[0]['duration'], '12')
        self.assertEqual(rows[0]['user'], '')
        self.assertEqual(rows[1]['duration'], '')
        self.assertEqual(rows[1]['user'], 'alice')

    def test_json_lines_preserve_nested_values_and_missing_fields(self):
        rows = self.rows(
            '{"event":"ok","count":2,"meta":{"a":1},"enabled":true}\n'
            '{"event":"done","extra":null}'
        )
        self.assertEqual(rows[0]['count'], '2')
        self.assertEqual(rows[0]['meta'], '{"a":1}')
        self.assertEqual(rows[0]['enabled'], 'true')
        self.assertEqual(rows[1]['count'], '')
        self.assertEqual(rows[1]['extra'], '')

    def test_common_and_combined_and_bracketed_access_logs(self):
        rows = self.rows(
            '127.0.0.1 - user [10/Nov/2026:10:00:00 +0000] "GET /a HTTP/1.1" 200 123 "-" "Browser"\n'
            '[10/Nov/2026:10:01:00 +0000] "POST /b HTTP/2" 201 42'
        )
        self.assertEqual(rows[0]['path'], '/a')
        self.assertEqual(rows[0]['user_agent'], 'Browser')
        self.assertEqual(rows[1]['method'], 'POST')
        self.assertEqual(rows[1]['status'], '201')

    def test_formula_cells_and_headers_are_escaped(self):
        rows = self.rows(
            '{"=header":"=HYPERLINK(\\"bad\\")","v":"  @command","n":"-1"}'
        )
        self.assertEqual(rows[0]["'=header"], '\'=HYPERLINK("bad")')
        self.assertEqual(rows[0]['v'], "'  @command")
        self.assertEqual(rows[0]['n'], "'-1")

    def test_rejects_malformed_records_without_silently_dropping_lines(self):
        for log in (
            '', 'plain unsupported text', 'a=1\nunsupported',
            'a=1 trailing text', 'a="unterminated', 'a=1 a=2',
            '{"a":1,"a":2}', '{"a":NaN}', '{}',
        ):
            with self.subTest(log=log):
                with self.assertRaises(ValueError):
                    logs_to_csv(log)

    def test_exact_input_and_line_limits(self):
        value = 'x' * (256 * 1024 - 2)
        self.assertEqual(logs_to_csv('a=' + value), 'a\r\n' + value + '\r\n')
        with self.assertRaisesMessage(ValueError, '256 KiB'):
            logs_to_csv('a=' + 'x' * (256 * 1024 - 1))
        self.assertEqual(len(self.rows('\n'.join(['a=1'] * 2000))), 2000)
        with self.assertRaisesMessage(ValueError, '2,000 lines'):
            logs_to_csv('\n'.join(['a=1'] * 2001))

    def test_exact_column_limit(self):
        self.assertEqual(len(self.rows(json.dumps({f'k{i}': i for i in range(100)}))[0]), 100)
        with self.assertRaisesMessage(ValueError, '100'):
            logs_to_csv(json.dumps({f'k{i}': i for i in range(101)}))


class ToolsEndpointTests(SimpleTestCase):
    def setUp(self):
        cache.clear()
        self.client = APIClient()
        self.client.credentials(
            HTTP_X_DEVELOPER_TOOLS='1',
            HTTP_ORIGIN=settings.CORS_ALLOWED_ORIGINS[0],
        )

    def tearDown(self):
        cache.clear()

    def test_csv_download_response(self):
        response = self.client.post(
            '/api/log-to-csv/', {'log': 'level=info code=200'}, format='json',
            HTTP_ACCEPT='text/csv, application/json',
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn('text/csv', response['Content-Type'])
        self.assertIn('logs.csv', response['Content-Disposition'])
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertEqual(response.content.decode(), 'level,code\r\ninfo,200\r\n')

    def test_validation_and_request_guard(self):
        for data in ({}, {'log': 1}, {'log': 'bad'}, []):
            response = self.client.post('/api/log-to-csv/', data, format='json')
            self.assertEqual(response.status_code, 400)
        client = APIClient()
        self.assertEqual(client.post('/api/log-to-csv/', {}).status_code, 403)
        response = client.post(
            '/api/log-to-csv/', {'log': 'a=1'}, format='json',
            HTTP_X_DEVELOPER_TOOLS='1', HTTP_ORIGIN='https://example.com',
        )
        self.assertEqual(response.status_code, 403)

    def test_preflight_supports_tool_header(self):
        response = self.client.options(
            '/api/log-to-csv/',
            HTTP_ACCESS_CONTROL_REQUEST_METHOD='POST',
            HTTP_ACCESS_CONTROL_REQUEST_HEADERS='content-type,x-developer-tools',
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn('x-developer-tools', response['Access-Control-Allow-Headers'])

    def test_throttles_requests(self):
        for _ in range(30):
            response = self.client.post('/api/log-to-csv/', {'log': 'a=1'}, format='json')
            self.assertEqual(response.status_code, 200)
        response = self.client.post('/api/log-to-csv/', {'log': 'a=1'}, format='json')
        self.assertEqual(response.status_code, 429)

    @override_settings(LOCAL_NOTES_ENABLED=False)
    def test_cloud_notes_are_denied_even_if_a_view_is_reached(self):
        response = self.client.get('/api/notes/', HTTP_X_LOCAL_NOTES='1')
        self.assertEqual(response.status_code, 403)


class ProductionSettingsTests(SimpleTestCase):
    def run_settings(self, **overrides):
        env = {key: value for key, value in os.environ.items() if not key.startswith('DJANGO_')}
        env.update({
            'DJANGO_SETTINGS_MODULE': 'config.settings',
            'DJANGO_ENV': 'production',
            'DJANGO_SECRET_KEY': 'test-only-not-a-deployment-secret-' * 3,
            'DJANGO_ALLOWED_HOSTS': 'tools.example.com',
            'DJANGO_EXTENSION_ORIGINS': settings.CORS_ALLOWED_ORIGINS[0],
            **overrides,
        })
        return subprocess.run(
            [sys.executable, '-c',
             'import django; django.setup(); '
             'from django.conf import settings; '
             'from django.urls import get_resolver; '
             'assert not settings.DEBUG; '
             'assert not settings.LOCAL_NOTES_ENABLED; '
             'assert settings.DATABASES["default"]["ENGINE"] == "django.db.backends.dummy"; '
             'assert not any("notes" in str(p.pattern) for p in '
             '__import__("api.urls", fromlist=["urlpatterns"]).urlpatterns)'],
            cwd=settings.BASE_DIR, env=env, capture_output=True, text=True, timeout=30,
        )

    def test_production_is_stateless_and_notes_routes_are_absent(self):
        result = self.run_settings()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_production_refuses_missing_or_unsafe_configuration(self):
        for overrides in (
            {'DJANGO_SECRET_KEY': ''},
            {'DJANGO_SECRET_KEY': 'a' * 64},
            {'DJANGO_ALLOWED_HOSTS': '*'},
            {'DJANGO_EXTENSION_ORIGINS': ''},
            {'DJANGO_EXTENSION_ORIGINS': 'https://example.com'},
        ):
            result = self.run_settings(**overrides)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('ImproperlyConfigured', result.stderr)
