import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { openFullPage, openSidePanel } from './extensionViews.js'

const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'chrome', original)
  else delete globalThis.chrome
})

test('opens the side panel in the active Chrome window', async () => {
  globalThis.chrome = {
    tabs: { async query(options) {
      assert.deepEqual(options, { active: true, currentWindow: true })
      return [{ windowId: 42 }]
    } },
    sidePanel: { async open(options) { assert.deepEqual(options, { windowId: 42 }) } },
  }
  await openSidePanel()
})

test('side-panel failures report missing APIs, absent windows and Chrome rejection', async () => {
  delete globalThis.chrome
  await assert.rejects(openSidePanel(), /Chrome 116/)
  globalThis.chrome = { sidePanel: { open() {} } }
  await assert.rejects(openSidePanel(), /loaded extension/)
  globalThis.chrome.tabs = { async query() { return [] } }
  await assert.rejects(openSidePanel(), /No active Chrome window/)
  const failure = new Error('Chrome denied panel opening')
  globalThis.chrome.tabs.query = async () => [{ windowId: 42 }]
  globalThis.chrome.sidePanel.open = async () => { throw failure }
  await assert.rejects(openSidePanel(), error => error === failure)
})

test('full-page view opens this extension entry point in an active tab', async () => {
  globalThis.chrome = {
    runtime: { getURL(path) {
      assert.equal(path, 'index.html')
      return 'chrome-extension://test-id/index.html'
    } },
    tabs: { async create(options) {
      assert.deepEqual(options, { url: 'chrome-extension://test-id/index.html', active: true })
    } },
  }
  await openFullPage()
})

test('full-page view reports unavailable APIs and failed tab creation', async () => {
  delete globalThis.chrome
  await assert.rejects(openFullPage(), /installed Chrome extension/)
  globalThis.chrome = { runtime: { getURL() {} } }
  await assert.rejects(openFullPage(), /full-page view/)
  const failure = new Error('Chrome refused the new tab')
  globalThis.chrome.runtime.getURL = () => 'chrome-extension://test-id/index.html'
  globalThis.chrome.tabs = { async create() { throw failure } }
  await assert.rejects(openFullPage(), error => error === failure)
})
