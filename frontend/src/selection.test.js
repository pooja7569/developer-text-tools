import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { readPageSelection, scrapeHighlightedText } from './selection.js'

const keys = ['chrome', 'document', 'window', 'HTMLInputElement', 'HTMLTextAreaElement']
const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

function browser(result, tab = { id: 7, url: 'https://example.com/' }) {
  globalThis.chrome = {
    tabs: { async query(options) {
      assert.deepEqual(options, { active: true, currentWindow: true })
      return tab ? [tab] : []
    } },
    scripting: { async executeScript(options) {
      assert.deepEqual(options.target, { tabId: 7 })
      assert.equal(options.func, readPageSelection)
      return [{ frameId: 0, result }]
    } },
  }
}

test('captures exact selected text with a main-frame-only injection', async () => {
  browser({ text: '  selected\ntext  ' })
  assert.equal(await scrapeHighlightedText(), '  selected\ntext  ')
})

test('rejects missing extension APIs, restricted tabs, and empty selection', async () => {
  delete globalThis.chrome
  await assert.rejects(scrapeHighlightedText(), /installed Chrome extension/)
  for (const tab of [null, { id: 7, url: 'chrome://extensions' }]) {
    browser({ text: 'x' }, tab)
    await assert.rejects(scrapeHighlightedText(), /normal HTTP or HTTPS/)
  }
  browser({ text: ' ' })
  await assert.rejects(scrapeHighlightedText(), /No highlighted text/)
})

test('rejects oversized UTF-8 selection and denied injections', async () => {
  browser({ text: '\u{1F600}'.repeat(65537) })
  await assert.rejects(scrapeHighlightedText(), /256 KiB/)
  browser({ text: 'x' })
  globalThis.chrome.scripting.executeScript = async () => { throw new Error('Denied') }
  await assert.rejects(scrapeHighlightedText(), /Chrome blocked/)
})

test('injected function reads textarea selection but never password values', () => {
  globalThis.HTMLInputElement = class {}
  globalThis.HTMLTextAreaElement = class {}
  globalThis.window = { getSelection: () => ({ toString: () => 'page text' }) }
  const field = new HTMLTextAreaElement()
  Object.assign(field, { value: 'before SELECT after', selectionStart: 7, selectionEnd: 13 })
  globalThis.document = { activeElement: field }
  assert.deepEqual(readPageSelection(), { text: 'SELECT' })
  const password = new HTMLInputElement()
  password.type = 'password'
  globalThis.document.activeElement = password
  assert.match(readPageSelection().error, /Password/)
  globalThis.document.activeElement = null
  assert.deepEqual(readPageSelection(), { text: 'page text' })
})
