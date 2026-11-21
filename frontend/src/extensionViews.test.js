import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { isFullPageView, isPopupView, isSidePanelView } from './extensionViews.js'

const original = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'chrome', original)
  else delete globalThis.chrome
})

test('only the actual popup window gets the fixed popup layout', () => {
  const popup = {}
  const tab = {}
  const panel = {}
  globalThis.chrome = { extension: { getViews(options) {
    assert.deepEqual(options, { type: 'popup' })
    return [popup]
  } } }
  assert.equal(isPopupView(popup), true)
  assert.equal(isPopupView(tab), false)
  assert.equal(isPopupView(panel), false)
  delete globalThis.chrome
  assert.equal(isPopupView(tab), false)
})

test('full-page detection distinguishes the extension tab from other views', () => {
  const tab = {}
  globalThis.chrome = { extension: { getViews(options) {
    assert.deepEqual(options, { type: 'tab' })
    return [tab]
  } } }
  assert.equal(isFullPageView(tab), true)
  assert.equal(isFullPageView({}), false)
  assert.equal(isFullPageView(undefined), false)
  delete globalThis.chrome
  assert.equal(isFullPageView(tab), false)
})
test('side-panel detection requires its own extension path and view marker', () => {
  const entry = 'chrome-extension://test-id/index.html'
  globalThis.chrome = { runtime: { getURL: () => entry } }
  assert.equal(isSidePanelView({ location: { href: `${entry}?view=side-panel` } }), true)
  assert.equal(isSidePanelView({ location: { href: entry } }), false)
  assert.equal(isSidePanelView({ location: { href: 'https://example.com/?view=side-panel' } }), false)
  delete globalThis.chrome
  assert.equal(isSidePanelView({ location: { href: `${entry}?view=side-panel` } }), false)
})
