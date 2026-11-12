import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { convertLogToCsv, formatJson } from './tools.js'

afterEach(() => mock.restoreAll())

test('formats valid JSON locally and reports invalid JSON', () => {
  assert.equal(formatJson('{"a":1}'), '{\n  "a": 1\n}')
  assert.throws(() => formatJson('{bad'), SyntaxError)
})

test('requests CSV explicitly without cookies', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    new Response('a\r\n1\r\n', { headers: { 'Content-Type': 'text/csv; charset=utf-8' } }),
  )
  assert.equal(await convertLogToCsv('a=1'), 'a\r\n1\r\n')
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url, 'http://127.0.0.1:8000/api/log-to-csv/')
  assert.equal(options.credentials, 'omit')
  assert.equal(options.headers.Accept, 'text/csv, application/json')
  assert.equal(options.headers['X-Developer-Tools'], '1')
  assert.deepEqual(JSON.parse(options.body), { log: 'a=1' })
})

test('rejects empty or oversized input without uploading', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('Must not fetch') })
  await assert.rejects(convertLogToCsv(' '), /Enter log/)
  await assert.rejects(convertLogToCsv('x'.repeat(256 * 1024 + 1)), /256 KiB/)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('reports server errors, wrong content types, and empty CSV', async () => {
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ detail: 'Line 2: unsupported log.' }, { status: 400 }),
  )
  await assert.rejects(convertLogToCsv('bad'), /Line 2/)
  mock.restoreAll()
  mock.method(globalThis, 'fetch', async () => Response.json({}))
  await assert.rejects(convertLogToCsv('a=1'), /did not return CSV/)
  mock.restoreAll()
  mock.method(globalThis, 'fetch', async () =>
    new Response('', { headers: { 'Content-Type': 'text/csv' } }),
  )
  await assert.rejects(convertLogToCsv('a=1'), /empty CSV/)
})
