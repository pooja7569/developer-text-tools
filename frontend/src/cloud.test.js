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
    assert.match(html, /role="combobox"[^>]*aria-expanded="false"/)
    assert.match(html, /role="listbox"[^>]*hidden=""/)
    assert.match(html, /JSON formatter|Log to CSV|JWT decoder/)
    assert.match(html, /Processed on this device/)
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
