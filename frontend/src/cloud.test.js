import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('cloud popup renders tools without local notes or a local greeting request', async () => {
  const previous = process.env.VITE_TOOLS_API_ORIGIN
  process.env.VITE_TOOLS_API_ORIGIN = 'https://tools.example.com'
  let server
  try {
    server = await createServer({
      mode: 'cloud',
      server: { middlewareMode: true, ws: false },
      appType: 'custom',
    })
    const { default: App } = await server.ssrLoadModule('/src/App.jsx')
    const html = renderToStaticMarkup(createElement(App))
    assert.match(html, /Capture selection/)
    assert.match(html, /<button[^>]*>Open full page<\/button>/)
    assert.match(html, /role="combobox"[^>]*aria-expanded="false"/)
    assert.match(html, /role="listbox"[^>]*hidden=""/)
    assert.match(html, /JSON formatter|Log to CSV|JWT decoder/)
    assert.match(html, /Processed on this device/)
    assert.match(html, /role="group" aria-label="Input actions"/)
    assert.match(html, /role="group" aria-label="Draft actions"/)
    assert.match(html, /Workspaces/)
    assert.doesNotMatch(html, /<button[^>]*>Download CSV<\/button>/)
    assert.match(html, /<button[^>]*>Format JSON<\/button>/)
    assert.match(html, /one saved workspace/)
    assert.match(html, /billing and sign-in are not available/)
    assert.doesNotMatch(html, /My notes|Fetch from Backend|Import JSON backup/)
  } finally {
    if (server) await server.close()
    if (previous === undefined) delete process.env.VITE_TOOLS_API_ORIGIN
    else process.env.VITE_TOOLS_API_ORIGIN = previous
  }
})

test('only the explicit pro-preview mode enables advanced workspace mutations', async () => {
  const previous = process.env.VITE_PRO_PREVIEW
  process.env.VITE_PRO_PREVIEW = 'true'
  try {
    for (const mode of ['production', 'pro-preview']) {
      const server = await createServer({ mode, server: { middlewareMode: true, ws: false }, appType: 'custom' })
      try {
        const { proPreview, mutateStore, emptyStore } = await server.ssrLoadModule('/src/workspaces.js')
        assert.equal(proPreview, mode === 'pro-preview')
        const workspace = {
          id: 'a', name: 'API', baseline: '{}', current: '{}', ignores: '/a',
          redaction: '', root: 'ApiResponse', extra: 'ignore', updatedAt: '2026-01-01T00:00:00Z',
        }
        const save = () => mutateStore(emptyStore(), { action: 'save', revision: 0, workspace }, proPreview)
        if (mode === 'pro-preview') assert.equal(save().workspaces.length, 1)
        else assert.throws(save, /Advanced/)
      } finally {
        await server.close()
      }
    }
  } finally {
    if (previous === undefined) delete process.env.VITE_PRO_PREVIEW
    else process.env.VITE_PRO_PREVIEW = previous
  }
})

test('full-page and side-panel views each offer their own Exit action', async () => {
  const previousOrigin = process.env.VITE_TOOLS_API_ORIGIN
  const descriptors = new Map(['window', 'chrome'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  process.env.VITE_TOOLS_API_ORIGIN = 'https://tools.example.com'
  let server
  try {
    server = await createServer({ mode: 'cloud', server: { middlewareMode: true, ws: false }, appType: 'custom' })
    const { default: App } = await server.ssrLoadModule('/src/App.jsx')
    const entry = 'chrome-extension://test-id/index.html'
    const view = { location: { href: entry } }
    globalThis.window = view
    for (const context of ['tab', 'popup', 'side-panel']) {
      view.location.href = context === 'side-panel' ? `${entry}?view=side-panel` : entry
      globalThis.chrome = {
        runtime: { getURL: () => entry },
        extension: { getViews: ({ type }) => type === context ? [view] : [] },
      }
      const html = renderToStaticMarkup(createElement(App))
      if (context === 'tab') {
        assert.match(html, />Exit full page<\/button>/)
        assert.doesNotMatch(html, />Open full page<\/button>/)
      } else {
        assert.match(html, />Open full page<\/button>/)
        assert.doesNotMatch(html, />Exit full page<\/button>/)
      }
      if (context === 'side-panel') {
        assert.match(html, />Exit side panel<\/button>/)
        assert.doesNotMatch(html, />Open side panel<\/button>/)
      } else {
        assert.match(html, />Open side panel<\/button>/)
        assert.doesNotMatch(html, />Exit side panel<\/button>/)
      }
    }
  } finally {
    if (server) await server.close()
    if (previousOrigin === undefined) delete process.env.VITE_TOOLS_API_ORIGIN
    else process.env.VITE_TOOLS_API_ORIGIN = previousOrigin
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})

test('account-enabled cloud UI labels billing as TEST and does not include local notes', async () => {
  const previousEnabled = process.env.VITE_ACCOUNTS_ENABLED
  const previousOrigin = process.env.VITE_TOOLS_API_ORIGIN
  process.env.VITE_ACCOUNTS_ENABLED = 'true'
  process.env.VITE_TOOLS_API_ORIGIN = 'https://tools.example.com'
  let server
  try {
    server = await createServer({ mode: 'cloud', server: { middlewareMode: true, ws: false }, appType: 'custom' })
    const { default: App } = await server.ssrLoadModule('/src/App.jsx')
    const html = renderToStaticMarkup(createElement(App))
    assert.match(html, /Sign in with Google/)
    assert.match(html, /Stripe TEST subscriptions/)
    assert.match(html, /No real charges/)
    assert.match(html, /<details class="account-panel"[^>]*>/)
    assert.doesNotMatch(html, /<details class="account-panel"[^>]* open[=> ]/)
    assert.doesNotMatch(html, /Fetch from Backend|My notes|Development Pro preview/)
    const account = await server.ssrLoadModule('/src/account.js')
    assert.equal(account.accountsEnabled, true)
  } finally {
    await server?.close()
    if (previousEnabled === undefined) delete process.env.VITE_ACCOUNTS_ENABLED
    else process.env.VITE_ACCOUNTS_ENABLED = previousEnabled
    if (previousOrigin === undefined) delete process.env.VITE_TOOLS_API_ORIGIN
    else process.env.VITE_TOOLS_API_ORIGIN = previousOrigin
  }
})

test('a restored view retains actual editor values, selected tool, baseline and unsaved local note fields', async () => {
  const server = await createServer({ mode: 'production', server: { middlewareMode: true, ws: false }, appType: 'custom' })
  try {
    const { default: App } = await server.ssrLoadModule('/src/App.jsx')
    const snapshot = {
      app: { message: 'Restored response', error: '', localToolsOpen: true },
      workspace: {
        tab: 'Tools', tool: 'json-yaml', input: '{"id":9007199254740993123,"text":"<&"}',
        baseline: '{"id":1}', output: 'id: 9007199254740993123\n', extension: 'yaml',
      },
      notes: { notes: [], text: 'Unsaved local note <&', query: 'find this' },
    }
    const render = () => renderToStaticMarkup(createElement(App, {
      initialSnapshot: snapshot, viewContext: { mode: 'full-page', windowId: 7 },
    }))
    const assertTextarea = (html, id, value) => {
      const encoded = renderToStaticMarkup(createElement('span', null, value)).slice(6, -7)
      const match = html.match(new RegExp(`<textarea[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/textarea>`))
      assert.equal(match?.[1], encoded)
    }
    let html = render()
    assertTextarea(html, 'tool-input', snapshot.workspace.input)
    assertTextarea(html, 'tool-output', snapshot.workspace.output)
    assertTextarea(html, 'note-text', snapshot.notes.text)
    assert.match(html, /JSON to YAML/)
    assert.match(html, /<details class="local-tools" open=""/)
    assert.match(html, /id="note-search"[^>]*value="find this"/)
    snapshot.workspace.tab = 'Compare'
    html = render()
    assertTextarea(html, 'baseline', snapshot.workspace.baseline)
    assertTextarea(html, 'tool-input', snapshot.workspace.input)
  } finally {
    await server.close()
  }
})
