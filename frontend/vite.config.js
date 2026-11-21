import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const cloud = mode === 'cloud'
  const proPreview = mode === 'pro-preview'
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const accounts = env.VITE_ACCOUNTS_ENABLED === 'true'
  if (accounts && proPreview) throw new Error('Use a normal build for account/test-billing integration, not the Pro preview.')
  const rawOrigin = env.VITE_TOOLS_API_ORIGIN || (cloud ? '' : 'http://127.0.0.1:8000')
  if (!rawOrigin) throw new Error('Set VITE_TOOLS_API_ORIGIN before a cloud build.')
  const url = new URL(rawOrigin)
  if (
    url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) ||
    (cloud && (url.protocol !== 'https:' || url.port))
  ) {
    throw new Error('Use an HTTPS origin without a path, credentials, or nonstandard port.')
  }
  const source = JSON.parse(readFileSync(
    new URL('./public/manifest.json', import.meta.url), 'utf8',
  ))
  const manifest = {
    ...source,
    ...(cloud && {
      name: 'DevToolBox: JSON & API Workspace',
    }),
    host_permissions: [`${url.protocol}//${url.hostname}/*`],
    content_security_policy: {
      extension_pages: `script-src 'self'; object-src 'none'; connect-src ${url.origin}`,
    },
  }
  // Chrome Web Store assigns the published identity; never ship the local development key.
  if (cloud) delete manifest.key
  if (accounts) manifest.permissions = [...manifest.permissions, 'identity']
  return {
    plugins: [
      react(),
      {
        name: 'extension-manifest',
        writeBundle(output) {
          writeFileSync(
            resolve(output.dir, 'manifest.json'), JSON.stringify(manifest, null, 2),
          )
        },
      },
    ],
    base: './',
    build: {
      outDir: cloud ? 'dist-cloud' : proPreview ? 'dist-pro-preview' : 'dist',
      rollupOptions: {
        input: {
          index: resolve(process.cwd(), 'index.html'),
          background: resolve(process.cwd(), 'src/background.js'),
        },
        output: { entryFileNames: (chunk) => chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js' },
      },
    },
    define: {
      'import.meta.env.VITE_TOOLS_API_ORIGIN': JSON.stringify(url.origin),
      'import.meta.env.VITE_CLOUD_BUILD': JSON.stringify(String(cloud)),
      'import.meta.env.VITE_PRO_PREVIEW': JSON.stringify(String(proPreview)),
      'import.meta.env.VITE_ACCOUNTS_ENABLED': JSON.stringify(String(accounts)),
    },
  }
})
