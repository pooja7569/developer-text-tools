import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import {
  emptyStore, mutateStore, parseWorkspaceBackup, STORAGE_KEY, STORAGE_LIMIT, validateStore,
} from './workspaces.js'

function workspace(id = 'a') {
  return {
    id, name: 'API', baseline: '{"a":1}', current: '{"a":2}', ignores: '',
    redaction: '', root: 'ApiResponse', extra: 'ignore', updatedAt: '2026-01-01T00:00:00Z',
  }
}

test('free saves exactly one workspace and allows updates and deletes without affecting notes', () => {
  const initial = emptyStore()
  const saved = mutateStore(initial, { action: 'save', revision: 0, workspace: workspace() })
  assert.equal(initial.workspaces.length, 0)
  assert.equal(saved.revision, 1)
  assert.throws(() => mutateStore(saved, { action: 'save', revision: 1, workspace: workspace('b') }), /one saved/)
  const updated = mutateStore(saved, { action: 'save', revision: 1, workspace: { ...workspace(), name: 'Updated' } })
  assert.equal(updated.workspaces[0].name, 'Updated')
  assert.equal(mutateStore(updated, { action: 'delete', revision: 2, id: 'a' }).workspaces.length, 0)
})

test('free users can read, export and delete preview workspaces but cannot save advanced presets', () => {
  let store = emptyStore()
  for (const id of ['a', 'b']) {
    store = mutateStore(store, { action: 'save', revision: store.revision, workspace: { ...workspace(id), ignores: '/a' } }, true)
  }
  assert.equal(validateStore(store).workspaces.length, 2)
  assert.deepEqual(parseWorkspaceBackup(JSON.stringify(store)), store)
  assert.throws(() => mutateStore(store, { action: 'save', revision: store.revision, workspace: { ...workspace(), ignores: '/a' } }), /Advanced/)
  const updated = mutateStore(store, { action: 'save', revision: store.revision, workspace: { ...workspace(), current: '{"a":3}' } })
  assert.equal(updated.workspaces.find((item) => item.id === 'a').ignores, '/a')
  assert.equal(updated.workspaces.find((item) => item.id === 'a').current, '{"a":3}')
  assert.equal(mutateStore(store, { action: 'delete', revision: store.revision, id: 'b' }).workspaces.length, 1)
})

test('imports are additive, duplicate IDs skip, and an oversized or invalid backup never mutates storage', () => {
  const store = mutateStore(emptyStore(), { action: 'save', revision: 0, workspace: workspace() })
  const backup = { version: 1, revision: 0, workspaces: [workspace(), workspace('b')] }
  assert.throws(() => mutateStore(store, { action: 'import', revision: 1, store: backup }), /limit/)
  const next = mutateStore(store, { action: 'import', revision: 1, store: backup }, true)
  assert.equal(next.workspaces.length, 2)
  assert.equal(store.workspaces.length, 1)
  assert.throws(() => parseWorkspaceBackup(' '.repeat(STORAGE_LIMIT + 1)), /4 MiB/)
  assert.throws(() => validateStore({ ...backup, workspaces: [workspace(), { ...workspace('b'), current: '{bad' }] }), SyntaxError)
  assert.throws(() => validateStore({ ...backup, version: 2 }), /corrupt/)
  assert.throws(() => validateStore({ ...backup, workspaces: [workspace(), workspace()] }), /unique/)
  assert.throws(() => validateStore({ ...backup, workspaces: Array.from({ length: 51 }, (_, i) => workspace(String(i))) }), /corrupt/)
  assert.throws(() => mutateStore(store, { action: 'delete', revision: 0, id: 'a' }), /another window/)
})

test('workspace storage accepts exactly 4 MiB and 50 entries, rejecting values above either limit', () => {
  const fullInput = JSON.stringify('x'.repeat(256 * 1024 - 2))
  const store = {
    version: 1, revision: 0,
    workspaces: Array.from({ length: 8 }, (_, index) => ({
      ...workspace(String(index)), baseline: fullInput, current: index === 7 ? '""' : fullInput,
    })),
  }
  const remaining = STORAGE_LIMIT - new TextEncoder().encode(JSON.stringify(store)).length
  store.workspaces[7].current = JSON.stringify('x'.repeat(remaining))
  assert.equal(new TextEncoder().encode(JSON.stringify(validateStore(store))).length, STORAGE_LIMIT)
  store.workspaces[7].current = JSON.stringify('x'.repeat(remaining + 1))
  assert.throws(() => validateStore(store), /4 MiB/)
  const maxStore = { version: 1, revision: 0, workspaces: Array.from({ length: 50 }, (_, i) => workspace(String(i))) }
  assert.equal(validateStore(maxStore).workspaces.length, 50)
  assert.throws(() => mutateStore(maxStore, { action: 'save', revision: 0, workspace: workspace('extra') }, true), /50 workspaces/)
})

test('background serializes writes, rejects stale popup revisions, and reports failed persistence', async () => {
  let listener
  const memory = {}
  const errors = mock.method(console, 'error', () => {})
  const previous = globalThis.chrome
  globalThis.chrome = {
    runtime: { id: 'test', getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (callback) => { listener = callback } } },
    storage: { local: {
      setAccessLevel: async () => {},
      get: async () => structuredClone(memory),
      set: async (value) => { await new Promise((resolve) => setTimeout(resolve, 5)); Object.assign(memory, value) },
    } },
  }
  try {
    await import('./background.js')
    const send = (request, sender = { id: 'test', url: 'chrome-extension://test/index.html' }) =>
      new Promise((resolve) => listener({ channel: STORAGE_KEY, ...request }, sender, resolve))
    const results = await Promise.all([
      send({ action: 'save', revision: 0, workspace: workspace() }),
      send({ action: 'save', revision: 0, workspace: workspace('b') }),
    ])
    assert.equal(results[0].ok, true)
    assert.equal(results[1].ok, false)
    assert.match(results[1].error, /another window/)
    assert.equal(memory[STORAGE_KEY].workspaces.length, 1)
    assert.equal((await send({ action: 'read' })).store.workspaces[0].id, 'a')
    assert.equal((await send({ action: 'read' }, { id: 'other', url: 'https://example.com' })).ok, false)
    const original = structuredClone(memory[STORAGE_KEY])
    mock.method(chrome.storage.local, 'set', async () => { throw new Error('Disk unavailable') })
    const failed = await send({ action: 'delete', revision: 1, id: 'a' })
    assert.match(failed.error, /Disk unavailable/)
    assert.deepEqual(memory[STORAGE_KEY], original)
    memory[STORAGE_KEY] = { invalid: 'data' }
    assert.equal((await send({ action: 'read' })).ok, false)
    assert.deepEqual(JSON.parse((await send({ action: 'export' })).backup), { invalid: 'data' })
  } finally {
    errors.mock.restore()
    mock.restoreAll()
    if (previous === undefined) delete globalThis.chrome
    else globalThis.chrome = previous
  }
})
