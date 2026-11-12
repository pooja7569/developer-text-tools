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
      server: { middlewareMode: true },
      appType: 'custom',
    })
    const { default: App } = await server.ssrLoadModule('/src/App.jsx')
    const html = renderToStaticMarkup(createElement(App))
    assert.match(html, /Scrape Highlighted Text/)
    assert.match(html, /Download CSV/)
    assert.match(html, /configured HTTPS server/)
    assert.doesNotMatch(html, /My notes|Fetch from Backend|Import JSON backup/)
  } finally {
    if (server) await server.close()
    if (previous === undefined) delete process.env.VITE_TOOLS_API_ORIGIN
    else process.env.VITE_TOOLS_API_ORIGIN = previous
  }
})
