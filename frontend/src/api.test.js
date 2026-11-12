import assert from 'node:assert/strict'
import { afterEach, mock, test } from 'node:test'
import { createNote, deleteNote, fetchGreeting, fetchNotes, importNotesBackup, updateNote } from './api.js'

afterEach(() => mock.restoreAll())

test('requests the loopback API without cookies and returns its message', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: 'Hello from your Django backend!' }),
  )

  assert.equal(await fetchGreeting(), 'Hello from your Django backend!')
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url, 'http://127.0.0.1:8000/api/greet/')
  assert.equal(options.credentials, 'omit')
  assert.equal(options.method, 'GET')
  assert.equal(options.cache, 'no-store')
  assert.ok(options.signal instanceof AbortSignal)
})

test('rejects unsuccessful HTTP responses', async () => {
  mock.method(globalThis, 'fetch', async () => new Response(null, { status: 500 }))
  await assert.rejects(fetchGreeting(), /HTTP 500/)
})

test('rejects invalid response shapes', async () => {
  for (const data of [null, {}, { message: 42 }]) {
    mock.method(globalThis, 'fetch', async () => Response.json(data))
    await assert.rejects(fetchGreeting(), /message string/)
    mock.restoreAll()
  }
})

test('propagates network and timeout failures', async () => {
  for (const error of [
    new TypeError('Failed to fetch'),
    new DOMException('Timed out', 'TimeoutError'),
  ]) {
    mock.method(globalThis, 'fetch', async () => { throw error })
    await assert.rejects(fetchGreeting(), (caught) => caught === error)
    mock.restoreAll()
  }
})

const note = { id: 1, text: 'My note', created_at: '2026-11-10T10:00:00Z' }

test('lists notes with the local request guard', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    Response.json([note]),
  )
  assert.deepEqual(await fetchNotes(), [note])
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url, 'http://127.0.0.1:8000/api/notes/')
  assert.equal(options.headers['X-Local-Notes'], '1')
})

test('saves notes as JSON without credentials', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    Response.json(note, { status: 201 }),
  )
  assert.deepEqual(await createNote('My note'), note)
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url, 'http://127.0.0.1:8000/api/notes/')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers['Content-Type'], 'application/json')
  assert.equal(options.headers['X-Local-Notes'], '1')
  assert.equal(options.credentials, 'omit')
  assert.deepEqual(JSON.parse(options.body), { text: 'My note' })
})

test('reports backend note validation errors', async () => {
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ text: ['This field may not be blank.'] }, { status: 400 }),
  )
  await assert.rejects(createNote(''), /This field may not be blank/)
})

test('rejects invalid notes response shapes', async () => {
  for (const data of [null, {}, [null], [{ ...note, id: '1' }],
    [{ ...note, created_at: 'invalid' }]]) {
    mock.method(globalThis, 'fetch', async () => Response.json(data))
    await assert.rejects(fetchNotes(), /invalid notes list/)
    mock.restoreAll()
  }
  mock.method(globalThis, 'fetch', async () => Response.json({}))
  await assert.rejects(createNote('My note'), /invalid saved note/)
})

test('updates the chosen note with a guarded JSON PATCH', async () => {
  const updated = { ...note, text: 'Edited' }
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    Response.json(updated),
  )
  assert.deepEqual(await updateNote(1, 'Edited'), updated)
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url, 'http://127.0.0.1:8000/api/notes/1/')
  assert.equal(options.method, 'PATCH')
  assert.equal(options.headers['X-Local-Notes'], '1')
  assert.equal(options.headers['Content-Type'], 'application/json')
  assert.equal(options.credentials, 'omit')
  assert.deepEqual(JSON.parse(options.body), { text: 'Edited' })
})

test('deletes the chosen note and handles the empty 204 response', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 204 }),
  )
  await deleteNote(1)
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url, 'http://127.0.0.1:8000/api/notes/1/')
  assert.equal(options.method, 'DELETE')
  assert.equal(options.headers['X-Local-Notes'], '1')
  assert.equal(options.credentials, 'omit')
  assert.equal(options.body, undefined)
})

test('shows edit validation errors and rejects invalid updated notes', async () => {
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ text: ['This field may not be blank.'] }, { status: 400 }),
  )
  await assert.rejects(updateNote(1, ''), /This field may not be blank/)
  mock.restoreAll()
  mock.method(globalThis, 'fetch', async () => Response.json({}))
  await assert.rejects(updateNote(1, 'Edited'), /invalid saved note/)
})

test('reports missing notes for updates and deletes', async () => {
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ detail: 'Not found.' }, { status: 404 }),
  )
  await assert.rejects(updateNote(1, 'Edited'), /no longer exists/)
  await assert.rejects(deleteNote(1), /no longer exists/)
})

test('does not report failed deletes as successful', async () => {
  mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 500 }),
  )
  await assert.rejects(deleteNote(1), /HTTP 500/)
})

const backup = { version: 1, exported_at: note.created_at, notes: [note] }

test('imports the complete backup through the guarded JSON endpoint', async () => {
  const result = { imported: 1, skipped: 0, notes: [note] }
  const fetchMock = mock.method(globalThis, 'fetch', async () =>
    Response.json(result),
  )
  assert.deepEqual(await importNotesBackup(backup), result)
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url, 'http://127.0.0.1:8000/api/notes/import/')
  assert.equal(options.method, 'POST')
  assert.equal(options.headers['X-Local-Notes'], '1')
  assert.equal(options.headers['Content-Type'], 'application/json')
  assert.equal(options.credentials, 'omit')
  assert.deepEqual(JSON.parse(options.body), backup)
})

test('handles duplicate-only imports and rejects inconsistent import results', async () => {
  const result = { imported: 0, skipped: 1, notes: [note] }
  mock.method(globalThis, 'fetch', async () => Response.json(result))
  assert.deepEqual(await importNotesBackup(backup), result)
  mock.restoreAll()
  for (const data of [
    null, {}, { imported: -1, skipped: 2, notes: [note] },
    { imported: 0, skipped: 0, notes: [note] },
    { imported: 1, skipped: 0, notes: [null] },
  ]) {
    mock.method(globalThis, 'fetch', async () => Response.json(data))
    await assert.rejects(importNotesBackup(backup), /invalid import result/)
    mock.restoreAll()
  }
})

test('reports server import errors without pretending an import succeeded', async () => {
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ detail: 'Backup is too large.' }, { status: 413 }),
  )
  await assert.rejects(importNotesBackup(backup), /too large/)
  mock.restoreAll()
  mock.method(globalThis, 'fetch', async () =>
    Response.json({ notes: ['Invalid note'] }, { status: 400 }),
  )
  await assert.rejects(importNotesBackup(backup), /Backup rejected \(HTTP 400\)/)
})
