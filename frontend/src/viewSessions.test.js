import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { clearWindowSession, handleViewAction, VIEW_EVENTS } from './viewSessions.js'

const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
afterEach(() => {
  if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor)
  else delete globalThis.chrome
})

const draft = () => ({
  app: { message: 'Backend response', error: '', localToolsOpen: true },
  workspace: {
    tab: 'Compare', tool: 'json-yaml', input: '{"id":9007199254740993123}', baseline: '{"id":1}',
    output: 'id: 9007199254740993123\n', extension: 'yaml', error: '', status: 'Processed locally.',
    rows: [{ path: '/id', type: 'number', value: '9007199254740993123' }], search: '/id',
    changes: { changes: [{ path: '/id', before: '1', after: '9007199254740993123' }] },
    ignores: '/meta/id', redaction: 'password', root: 'MyResponse', extra: 'forbid',
    selected: 'workspace-a', name: 'Unsaved workspace name', backup: { workspaces: [] },
    store: { version: 1, revision: 0, workspaces: [] }, storageReady: true,
  },
  notes: {
    notes: [{ id: 1, text: 'Saved note' }], query: 'query', text: 'Unsaved note',
    pendingBackup: null, editingId: 1, editText: 'Unsaved edit', deletingId: null, status: '', error: '',
  },
})

function browser() {
  const entry = 'chrome-extension://test-id/index.html'
  const stored = {}
  const contexts = []
  const tabs = [{ id: 10, windowId: 7, active: true }, { id: 20, windowId: 9, active: true }]
  const calls = []
  let nextId = 30
  const state = {
    stored, contexts, tabs, calls, hydrated: false, failWrite: false,
    failClose: false, failOpen: false, dismissPopupOnPanelClose: false,
  }
  function addContext(mode, windowId = 7, tabId = -1) {
    const id = nextId++
    const context = {
      contextId: `context-${id}`, documentId: `document-${id}`, documentUrl: entry,
      contextType: { popup: 'POPUP', 'full-page': 'TAB', 'side-panel': 'SIDE_PANEL' }[mode],
      windowId, tabId,
    }
    contexts.push(context)
    return context
  }
  function removeContext(id) {
    const index = contexts.findIndex(context => context.contextId === id)
    if (index >= 0) contexts.splice(index, 1)
  }
  function activate(tab) {
    for (const item of tabs) if (item.windowId === tab.windowId) item.active = item.id === tab.id
    for (const context of [...contexts]) {
      if (context.contextType === 'POPUP' && context.windowId === tab.windowId) removeContext(context.contextId)
    }
  }
  state.addContext = addContext
  state.sender = context => ({ id: 'test-id', url: entry, documentId: context.documentId })
  state.request = (context, action, extra = {}) => handleViewAction(
    {
      action, windowId: context.windowId,
      mode: { POPUP: 'popup', TAB: 'full-page', SIDE_PANEL: 'side-panel' }[context.contextType],
      ...(action !== 'restore' && { contextId: context.contextId }), ...extra,
    }, state.sender(context),
  )
  globalThis.chrome = {
    runtime: {
      id: 'test-id', getURL: name => `chrome-extension://test-id/${name}`,
      async getContexts() { return structuredClone(contexts) },
      async sendMessage(message) {
        assert.equal(message.channel, VIEW_EVENTS)
        calls.push(message)
        if (message.action === 'close') {
          assert.equal(state.hydrated, true, 'The old popup must not close before hydration')
          removeContext(message.contextId)
        }
        return { ok: true }
      },
    },
    storage: { session: {
      async setAccessLevel(options) { assert.deepEqual(options, { accessLevel: 'TRUSTED_CONTEXTS' }) },
      async get(key) { return Object.hasOwn(stored, key) ? { [key]: structuredClone(stored[key]) } : {} },
      async set(values) {
        if (state.failWrite) throw new Error('Session memory is full')
        Object.assign(stored, structuredClone(values))
      },
      async remove(key) { delete stored[key] },
    } },
    tabs: {
      async query(options) {
        return structuredClone(tabs.filter(tab => tab.windowId === options.windowId && (!options.active || tab.active)))
      },
      async create(options) {
        if (state.failOpen) throw new Error('Chrome refused the new view')
        const tab = { id: nextId++, windowId: options.windowId, active: true, url: options.url }
        tabs.push(tab)
        activate(tab)
        if (options.url === entry) addContext('full-page', tab.windowId, tab.id)
        calls.push({ action: 'create-tab', id: tab.id })
        return structuredClone(tab)
      },
      async update(id) {
        const tab = tabs.find(item => item.id === id)
        assert.ok(tab)
        activate(tab)
        calls.push({ action: 'activate-tab', id })
        return structuredClone(tab)
      },
      async remove(id) {
        assert.equal(state.hydrated, true, 'The old tab must not close before hydration')
        if (state.failClose) throw new Error('Chrome refused to close the previous view')
        const context = contexts.find(item => item.tabId === id && item.contextType === 'TAB')
        assert.ok(context, 'Never close a webpage tab')
        removeContext(context.contextId)
        tabs.splice(tabs.findIndex(tab => tab.id === id), 1)
        calls.push({ action: 'remove-tab', id })
      },
    },
    sidePanel: { async close({ windowId }) {
      assert.equal(state.hydrated, true, 'The old side panel must not close before hydration')
      if (state.failClose) throw new Error('Chrome refused to close the previous view')
      for (const context of [...contexts]) {
        if (context.windowId === windowId && (context.contextType === 'SIDE_PANEL' ||
          (state.dismissPopupOnPanelClose && context.contextType === 'POPUP'))) removeContext(context.contextId)
      }
      calls.push({ action: 'close-side-panel', windowId })
    } },
    action: { async openPopup({ windowId }) {
      if (state.failOpen) throw new Error('Chrome refused the new view')
      addContext('popup', windowId)
      calls.push({ action: 'open-popup', windowId })
    } },
  }
  return state
}

async function mount(state, context) {
  const restored = await state.request(context, 'restore')
  state.hydrated = true
  await state.request(context, 'ready', { transferId: restored.transferId })
  return restored
}

for (const documentIdAvailable of [true, false]) {
test(`all six transitions retain drafts with sender documentId ${documentIdAvailable ? 'present' : 'absent'}`, async () => {
  const state = browser()
  if (!documentIdAvailable) state.sender = context => ({ id: 'test-id', url: context.documentUrl })
  let source = state.addContext('popup')
  await mount(state, source)
  const other = state.addContext('popup', 9)
  await mount(state, other)
  const otherDraft = draft()
  otherDraft.workspace.input = 'Other window'
  await state.request(other, 'save', { snapshot: otherDraft })
  for (const [index, target] of ['full-page', 'side-panel', 'full-page', 'popup', 'side-panel', 'popup'].entries()) {
    const snapshot = draft()
    snapshot.workspace.input += `\n${index}`
    snapshot.workspace.output += `latest-${index}`
    const saved = await state.request(source, 'save', { snapshot })
    state.hydrated = false
    if (target === 'side-panel') state.addContext('side-panel')
    await state.request(source, 'open', { target, revision: saved.revision })
    const destination = state.contexts.find(context =>
      context.windowId === 7 && context.contextType === { popup: 'POPUP', 'full-page': 'TAB', 'side-panel': 'SIDE_PANEL' }[target])
    assert.ok(destination)
    if (source.contextType !== 'POPUP') assert.ok(state.contexts.includes(source))
    const restored = await state.request(destination, 'restore')
    assert.deepEqual(restored.snapshot, snapshot)
    state.hydrated = true
    await state.request(destination, 'ready', { transferId: restored.transferId })
    assert.deepEqual(state.contexts.filter(context => context.windowId === 7), [destination])
    assert.ok(state.tabs.some(tab => tab.id === 10), 'Original webpage remains')
    assert.deepEqual(state.stored['devtoolbox-view-session-v1:9'].snapshot, otherDraft)
    if (target !== 'full-page') assert.equal(state.tabs.find(tab => tab.id === 10).active, true)
    source = destination
  }
})
}

test('missing sender document IDs do not permit ambiguous views or claiming another live document', async () => {
  const state = browser()
  const source = state.addContext('popup')
  const other = state.addContext('popup')
  state.sender = context => ({ id: 'test-id', url: context.documentUrl })
  await assert.rejects(state.request(source, 'restore'), /own Chrome window/)
  state.contexts.splice(state.contexts.indexOf(other), 1)
  await mount(state, source)
  await assert.rejects(state.request(source, 'save', { contextId: 'unknown', snapshot: draft() }), /own Chrome window/)
  await assert.rejects(state.request(source, 'save', { windowId: 9, snapshot: draft() }), /another view/)
  state.sender = context => ({ id: 'test-id', url: context.documentUrl, documentId: context.documentId })
  await assert.rejects(state.request(source, 'save', { contextId: 'another-context', snapshot: draft() }), /own Chrome window/)
})

test('side-panel exit reopens the hydrated popup if closing the panel dismisses it', async () => {
  const state = browser()
  state.dismissPopupOnPanelClose = true
  state.sender = context => ({ id: 'test-id', url: context.documentUrl })
  const source = state.addContext('side-panel')
  await mount(state, source)
  const snapshot = draft()
  const saved = await state.request(source, 'save', { snapshot })
  await state.request(source, 'open', { target: 'popup', revision: saved.revision })
  const popup = state.contexts.find(context => context.contextType === 'POPUP')
  const restored = await state.request(popup, 'restore')
  assert.deepEqual(restored.snapshot, snapshot)
  assert.ok(state.contexts.includes(source))
  await state.request(popup, 'ready', { transferId: restored.transferId })
  const reopened = state.contexts.find(context => context.contextType === 'POPUP')
  assert.ok(reopened)
  assert.notEqual(reopened.contextId, popup.contextId)
  const final = await mount(state, reopened)
  assert.deepEqual(final.snapshot, snapshot)
  assert.deepEqual(state.contexts, [reopened])
  assert.equal(state.tabs.find(tab => tab.id === 10).active, true)
  assert.equal(state.calls.filter(call => call.action === 'open-popup').length, 2)
  assert.equal(state.stored['devtoolbox-view-session-v1:7'].pending, null)
})

test('failed popup reopening reports the failure and preserves drafts for a manual toolbar retry', async () => {
  const state = browser()
  state.dismissPopupOnPanelClose = true
  const source = state.addContext('side-panel')
  await mount(state, source)
  const snapshot = draft()
  const saved = await state.request(source, 'save', { snapshot })
  await state.request(source, 'open', { target: 'popup', revision: saved.revision })
  const popup = state.contexts.find(context => context.contextType === 'POPUP')
  const restored = await state.request(popup, 'restore')
  state.failOpen = true
  await assert.rejects(state.request(popup, 'ready', { transferId: restored.transferId }), /refused the new view/)
  assert.deepEqual(state.stored['devtoolbox-view-session-v1:7'].snapshot, snapshot)
  state.failOpen = false
  const reopened = state.addContext('popup')
  assert.deepEqual((await mount(state, reopened)).snapshot, snapshot)
  assert.deepEqual(state.contexts, [reopened])
})

test('session writes and failed opening keep the existing view and its confirmed draft intact', async () => {
  const state = browser()
  const source = state.addContext('popup')
  await mount(state, source)
  const snapshot = draft()
  const saved = await state.request(source, 'save', { snapshot })
  state.failWrite = true
  await assert.rejects(state.request(source, 'save', { snapshot: { ...snapshot, workspace: { ...snapshot.workspace, input: 'New draft' } } }), /memory is full/)
  assert.deepEqual(state.stored['devtoolbox-view-session-v1:7'].snapshot, snapshot)
  state.failWrite = false
  state.failOpen = true
  await assert.rejects(state.request(source, 'open', { target: 'full-page', revision: saved.revision }), /refused the new view/)
  assert.ok(state.contexts.includes(source))
  assert.deepEqual(state.stored['devtoolbox-view-session-v1:7'].snapshot, snapshot)
})

test('closing failure retains the restored data and allows retrying completion without losing either view', async () => {
  const state = browser()
  const source = state.addContext('side-panel')
  await mount(state, source)
  const snapshot = draft()
  const saved = await state.request(source, 'save', { snapshot })
  await state.request(source, 'open', { target: 'full-page', revision: saved.revision })
  const destination = state.contexts.find(context => context.contextType === 'TAB')
  const restored = await state.request(destination, 'restore')
  assert.deepEqual(restored.snapshot, snapshot)
  state.failClose = true
  await assert.rejects(state.request(destination, 'ready', { transferId: restored.transferId }), /refused to close/)
  assert.ok(state.contexts.includes(source))
  assert.ok(state.contexts.includes(destination))
  state.failClose = false
  await state.request(destination, 'ready', { transferId: restored.transferId })
  assert.deepEqual(state.contexts, [destination])
})

test('a stale or wrong-window caller cannot overwrite or redirect an active session', async () => {
  const state = browser()
  const source = state.addContext('popup')
  await mount(state, source)
  const saved = await state.request(source, 'save', { snapshot: draft() })
  const other = state.addContext('popup', 9)
  await assert.rejects(handleViewAction({ action: 'restore', windowId: 7 }, state.sender(other)), /own Chrome window/)
  await assert.rejects(state.request(source, 'open', { target: 'full-page', revision: saved.revision - 1 }), /finish syncing/)
  await assert.rejects(state.request(other, 'save', { snapshot: draft() }), /another view/)
  assert.deepEqual(state.contexts, [source, other])
  await assert.rejects(state.request(source, 'save', { snapshot: { app: {}, workspace: {} } }), /cannot be transferred/)
  const beforeMove = structuredClone(state.stored['devtoolbox-view-session-v1:7'])
  source.windowId = 9
  await assert.rejects(state.request(source, 'save', { windowId: 7, snapshot: draft() }), /moved to a different Chrome window/)
  await assert.rejects(state.request(source, 'open', { windowId: 7, target: 'full-page', revision: saved.revision }), /moved to a different Chrome window/)
  assert.deepEqual(state.stored['devtoolbox-view-session-v1:7'], beforeMove)
})

test('reopening an existing destination restores it rather than creating another extension tab', async () => {
  const state = browser()
  const tab = await chrome.tabs.create({ windowId: 7, url: chrome.runtime.getURL('index.html'), active: true })
  const destination = state.contexts.find(context => context.tabId === tab.id)
  await mount(state, destination)
  const source = state.addContext('side-panel')
  // Model a retained, initialized destination context without closing it during this setup.
  state.stored['devtoolbox-view-session-v1:7'].owner = {
    ...source, mode: 'side-panel',
  }
  const saved = await state.request(source, 'save', { snapshot: draft() })
  const creates = state.calls.filter(call => call.action === 'create-tab').length
  await state.request(source, 'open', { target: 'full-page', revision: saved.revision })
  assert.equal(state.calls.filter(call => call.action === 'create-tab').length, creates)
  assert.ok(state.calls.some(call => call.action === 'restore' && call.contextId === destination.contextId))
  const restored = await state.request(destination, 'restore')
  assert.deepEqual(restored.snapshot, draft())
})

test('returning to popup creates a normal host tab if the original webpage was closed', async () => {
  const state = browser()
  state.tabs.splice(state.tabs.findIndex(tab => tab.windowId === 7), 1)
  const tab = await chrome.tabs.create({ windowId: 7, url: chrome.runtime.getURL('index.html'), active: true })
  const source = state.contexts.find(context => context.tabId === tab.id)
  await mount(state, source)
  const saved = await state.request(source, 'save', { snapshot: draft() })
  await state.request(source, 'open', { target: 'popup', revision: saved.revision })
  assert.ok(state.tabs.some(item => item.windowId === 7 && item.url === undefined))
  const destination = state.contexts.find(context => context.contextType === 'POPUP' && context.windowId === 7)
  const restored = await state.request(destination, 'restore')
  await state.request(destination, 'ready', { transferId: restored.transferId })
  assert.deepEqual(state.contexts.filter(context => context.windowId === 7), [destination])
})

test('a source tab that navigated away from the extension is never closed', async () => {
  const state = browser()
  const tab = await chrome.tabs.create({ windowId: 7, url: chrome.runtime.getURL('index.html'), active: true })
  const source = state.contexts.find(context => context.tabId === tab.id)
  await mount(state, source)
  const saved = await state.request(source, 'save', { snapshot: draft() })
  state.addContext('side-panel')
  await state.request(source, 'open', { target: 'side-panel', revision: saved.revision })
  state.contexts.splice(state.contexts.indexOf(source), 1)
  state.tabs.find(item => item.id === tab.id).url = 'https://example.com'
  const destination = state.contexts.find(context => context.contextType === 'SIDE_PANEL')
  const restored = await state.request(destination, 'restore')
  await state.request(destination, 'ready', { transferId: restored.transferId })
  assert.ok(state.tabs.some(item => item.id === tab.id && item.url === 'https://example.com'))
  assert.equal(state.calls.filter(call => call.action === 'remove-tab').length, 0)
})

test('opening the toolbar popup directly from the only full-page tab keeps a host window and reopens the popup with its data', async () => {
  const state = browser()
  state.tabs.splice(state.tabs.findIndex(tab => tab.windowId === 7), 1)
  const tab = await chrome.tabs.create({ windowId: 7, url: chrome.runtime.getURL('index.html'), active: true })
  const source = state.contexts.find(context => context.tabId === tab.id)
  await mount(state, source)
  const snapshot = draft()
  await state.request(source, 'save', { snapshot })
  await chrome.action.openPopup({ windowId: 7 })
  const popup = state.contexts.find(context => context.contextType === 'POPUP')
  await mount(state, popup)
  const reopened = state.contexts.find(context => context.contextType === 'POPUP')
  assert.notEqual(reopened.contextId, popup.contextId)
  const restored = await mount(state, reopened)
  assert.deepEqual(restored.snapshot, snapshot)
  assert.deepEqual(state.contexts.filter(context => context.windowId === 7), [reopened])
  assert.ok(state.tabs.some(item => item.windowId === 7 && item.url === undefined))
})

test('closing one Chrome window clears only its temporary draft, and older Chrome is rejected', async () => {
  const state = browser()
  const source = state.addContext('popup')
  await mount(state, source)
  await state.request(source, 'save', { snapshot: draft() })
  const other = state.addContext('popup', 9)
  await mount(state, other)
  await state.request(other, 'save', { snapshot: draft() })
  await clearWindowSession(7)
  assert.equal(state.stored['devtoolbox-view-session-v1:7'], undefined)
  assert.ok(state.stored['devtoolbox-view-session-v1:9'].snapshot)
  delete chrome.sidePanel.close
  await assert.rejects(state.request(other, 'restore'), /Chrome 141/)
})
