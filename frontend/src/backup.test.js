import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { exportNotesBackup, readNotesBackup } from './backup.js'
import { downloadText } from './download.js'

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

afterEach(() => {
  mock.restoreAll()
  if (originalDocument) {
    Object.defineProperty(globalThis, 'document', originalDocument)
  } else {
    delete globalThis.document
  }
})

function mockDownload({ failClick = false } = {}) {
  const state = { blob: null, clicked: false, removed: false, revoke: null }
  const link = {
    click() {
      if (failClick) throw new Error('Download could not be started.')
      state.clicked = true
    },
    remove() { state.removed = true },
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tag) {
        assert.equal(tag, 'a')
        return link
      },
      body: { append(element) { assert.equal(element, link) } },
    },
  })
  mock.method(URL, 'createObjectURL', (blob) => {
    state.blob = blob
    return 'blob:backup-test'
  })
  const revoke = mock.method(URL, 'revokeObjectURL', () => {})
  mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 1000)
    state.revoke = callback
  })
  return { state, link, revoke }
}

test('exports all freshly fetched notes with versioned metadata and exact text', async () => {
  const notes = [
    { id: 2, text: 'Tea\n"quoted" \\ text', created_at: '2026-11-10T10:00:00Z' },
    { id: 1, text: 'Coffee \u2615', created_at: '2026-11-09T10:00:00Z' },
  ]
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    Response.json(notes),
  )
  const { state, link, revoke } = mockDownload()
  const before = Date.now()
  assert.equal(await exportNotesBackup(), 2)
  const after = Date.now()
  const backup = JSON.parse(await state.blob.text())

  assert.deepEqual(Object.keys(backup), ['version', 'exported_at', 'notes'])
  assert.equal(backup.version, 1)
  assert.ok(Date.parse(backup.exported_at) >= before)
  assert.ok(Date.parse(backup.exported_at) <= after)
  assert.deepEqual(backup.notes, notes)
  assert.equal(state.blob.type, 'application/json;charset=utf-8')
  assert.match(link.download, /^local-notes-[0-9T-Z-]+\.json$/)
  assert.equal(link.href, 'blob:backup-test')
  assert.equal(link.hidden, true)
  assert.equal(state.clicked, true)
  assert.equal(state.removed, true)
  assert.equal(revoke.mock.callCount(), 0)
  state.revoke()
  assert.deepEqual(revoke.mock.calls[0].arguments, ['blob:backup-test'])

  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(url, 'http://127.0.0.1:8000/api/notes/')
  assert.equal(options.method, 'GET')
  assert.equal(options.cache, 'no-store')
  assert.equal(options.headers['X-Local-Notes'], '1')
})

test('exports a valid empty backup when there are no notes', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json([]))
  const { state } = mockDownload()
  assert.equal(await exportNotesBackup(), 0)
  assert.deepEqual(JSON.parse(await state.blob.text()).notes, [])
})

test('downloads CSV with its UTF-8 BOM, CSV filename, and text content intact', async () => {
  const { state, link } = mockDownload()
  downloadText('\uFEFFmessage\r\n"Hello, world"\r\n', 'logs.csv', 'text/csv;charset=utf-8')
  assert.equal(link.download, 'logs.csv')
  assert.equal(state.blob.type, 'text/csv;charset=utf-8')
  const bytes = new Uint8Array(await state.blob.arrayBuffer())
  assert.deepEqual([...bytes.slice(0, 3)], [239, 187, 191])
  assert.equal(await state.blob.text(), 'message\r\n"Hello, world"\r\n')
  assert.equal(state.clicked, true)
})

test('does not download stale or invalid data when fetching fails', async () => {
  const { state } = mockDownload()
  const failure = new TypeError('Failed to fetch')
  mock.method(globalThis, 'fetch', async () => { throw failure })
  await assert.rejects(exportNotesBackup(), (error) => error === failure)
  assert.equal(state.blob, null)
  assert.equal(state.clicked, false)
})

test('rejects invalid backend responses before creating a download', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ notes: [] }))
  const { state } = mockDownload()
  await assert.rejects(exportNotesBackup(), /invalid notes list/)
  assert.equal(state.blob, null)
})

test('surfaces download initiation failures and releases temporary resources', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json([]))
  const { state, revoke } = mockDownload({ failClick: true })
  await assert.rejects(exportNotesBackup(), /Download could not be started/)
  assert.equal(state.removed, true)
  state.revoke()
  assert.equal(revoke.mock.callCount(), 1)
})

function backupFile(notes = [], extra = {}) {
  const data = {
    version: 1,
    exported_at: '2026-11-10T10:00:00Z',
    notes,
    ...extra,
  }
  return new File([JSON.stringify(data)], 'backup.json', { type: 'application/json' })
}

const savedNote = { id: 1, text: 'Restored\nnote', created_at: '2026-01-01T00:00:00Z' }

test('reads exported backup format and preserves original text', async () => {
  const backup = await readNotesBackup(backupFile([savedNote]))
  assert.equal(backup.version, 1)
  assert.deepEqual(backup.notes, [savedNote])
  assert.deepEqual((await readNotesBackup(backupFile())).notes, [])
})

test('accepts a UTF-8 BOM from Windows editors', async () => {
  const file = backupFile([savedNote])
  const bomFile = new File(['\uFEFF', await file.text()], 'backup.json')
  assert.deepEqual((await readNotesBackup(bomFile)).notes, [savedNote])
})

test('rejects invalid JSON and unsupported backup shapes', async () => {
  await assert.rejects(readNotesBackup(new File(['{bad'], 'bad.json')), /valid JSON/)
  for (const extra of [
    { version: 2 }, { version: '1' }, { version: true },
    { exported_at: 'invalid' }, { notes: {} },
  ]) {
    await assert.rejects(readNotesBackup(backupFile([], extra)), /version 1/)
  }
})

test('rejects bad note metadata, blank text, and non-string text', async () => {
  for (const invalid of [
    null, { ...savedNote, id: 0 }, { ...savedNote, id: '1' },
    { ...savedNote, text: ' \n ' }, { ...savedNote, text: 42 },
    { ...savedNote, text: 'a'.repeat(2001) },
    { ...savedNote, created_at: 'invalid' },
  ]) {
    await assert.rejects(readNotesBackup(backupFile([invalid])), /Note 1 is invalid/)
  }
})

test('enforces exact 500-note and 2,000-character limits', async () => {
  const notes = Array.from({ length: 500 }, (_, index) => ({
    ...savedNote, id: index + 1,
  }))
  notes[0].text = 'a'.repeat(2000)
  assert.equal((await readNotesBackup(backupFile(notes))).notes.length, 500)
  await assert.rejects(readNotesBackup(backupFile([...notes, savedNote])), /500 notes/)
  const unicodeNote = { ...savedNote, text: '\u{1F600}'.repeat(2000) }
  assert.equal((await readNotesBackup(backupFile([unicodeNote]))).notes.length, 1)
})

test('enforces the exact 1 MB file limit before reading oversized files', async () => {
  const base = await backupFile().text()
  const exact = new File([base, ' '.repeat(1024 * 1024 - base.length)], 'exact.json')
  assert.equal(exact.size, 1024 * 1024)
  assert.deepEqual((await readNotesBackup(exact)).notes, [])
  let read = false
  await assert.rejects(readNotesBackup({
    size: 1024 * 1024 + 1,
    async text() { read = true; return base },
  }), /1 MB/)
  assert.equal(read, false)
})

test('surfaces file read errors instead of showing an empty import', async () => {
  const failure = new Error('File cannot be read')
  await assert.rejects(readNotesBackup({
    size: 10,
    async text() { throw failure },
  }), (error) => error === failure)
})
