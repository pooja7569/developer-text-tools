import assert from 'node:assert/strict'
import { after, afterEach, before, mock, test } from 'node:test'
import { createServer } from 'vite'

let server
let accountModule
let previousEnabled
const previousChrome = globalThis.chrome
const SESSION_KEY = 'devtoolbox.account.session'
const TOKEN = 't'.repeat(43)
const future = () => new Date(Date.now() + 3600000).toISOString()
const freeAccount = () => ({
  email: 'person@example.com', pro: false, pro_until: null,
  subscription_status: 'none', billing_mode: 'test',
})
const proAccount = () => ({ ...freeAccount(), pro: true, pro_until: future(), subscription_status: 'active' })

before(async () => {
  previousEnabled = process.env.VITE_ACCOUNTS_ENABLED
  process.env.VITE_ACCOUNTS_ENABLED = 'true'
  server = await createServer({ server: { middlewareMode: true, ws: false }, appType: 'custom' })
  accountModule = await server.ssrLoadModule('/src/account.js')
})

after(async () => {
  await server?.close()
  if (previousEnabled === undefined) delete process.env.VITE_ACCOUNTS_ENABLED
  else process.env.VITE_ACCOUNTS_ENABLED = previousEnabled
})

afterEach(() => {
  mock.restoreAll()
  if (previousChrome === undefined) delete globalThis.chrome
  else globalThis.chrome = previousChrome
})

function browser() {
  const sessionMemory = {}
  const localMemory = {}
  let listener
  function storage(memory) {
    return {
      setAccessLevel: async () => {},
      get: async () => structuredClone(memory),
      set: async (value) => Object.assign(memory, structuredClone(value)),
      remove: async (key) => { delete memory[key] },
    }
  }
  const chrome = {
    storage: { local: storage(localMemory), session: storage(sessionMemory) },
    identity: {
      getRedirectURL: () => 'https://test.chromiumapp.org/auth',
      launchWebAuthFlow: async () => 'https://test.chromiumapp.org/auth#ticket=' + 'c'.repeat(43),
    },
    tabs: { create: async () => {} },
    runtime: {
      id: 'test', getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: (handler) => { listener = handler } },
    },
  }
  globalThis.chrome = chrome
  return {
    chrome, sessionMemory, localMemory,
    send: (request, sender = { id: 'test', url: 'chrome-extension://test/index.html' }) =>
      new Promise((resolve) => listener(request, sender, resolve)),
  }
}

test('Google flow uses PKCE and stores only an expiring application token in trusted session storage', async () => {
  const { chrome, sessionMemory, localMemory } = browser()
  const access = mock.method(chrome.storage.session, 'setAccessLevel')
  let challenge
  mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.credentials, 'omit')
    assert.equal(options.redirect, 'error')
    const body = options.body ? JSON.parse(options.body) : null
    if (url.endsWith('/google/start/')) {
      challenge = body.challenge
      assert.equal(body.redirect_uri, 'https://test.chromiumapp.org/auth')
      return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=test' })
    }
    if (url.endsWith('/exchange/')) {
      const expected = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.verifier))).toString('base64url')
      assert.equal(challenge, expected)
      assert.equal(body.ticket, 'c'.repeat(43))
      assert.equal(options.headers.Authorization, undefined)
      return Response.json({ token: TOKEN, expires_at: future(), account: freeAccount() })
    }
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`)
    return Response.json(freeAccount())
  })
  const result = await accountModule.handleAccountAction('signin')
  assert.equal(result.signedIn, true)
  assert.equal(sessionMemory[SESSION_KEY].token, TOKEN)
  assert.deepEqual(localMemory, {})
  assert.ok(access.mock.calls.every((call) => call.arguments[0].accessLevel === 'TRUSTED_CONTEXTS'))
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('rejects unexpected OAuth endpoints and callback destinations without persisting a token', async () => {
  const { chrome, sessionMemory } = browser()
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ url: 'https://evil.example/login' }))
  await assert.rejects(accountModule.handleAccountAction('signin'), /unexpected sign-in URL/)
  fetchMock.mock.mockImplementation(async () => Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }))
  mock.method(chrome.identity, 'launchWebAuthFlow', async () => 'https://evil.example/auth#ticket=' + 'c'.repeat(43))
  await assert.rejects(accountModule.handleAccountAction('signin'), /Invalid sign-in callback/)
  assert.deepEqual(sessionMemory, {})
})

test('server revocation or expiry clears session and never returns cached Pro access', async () => {
  const { sessionMemory } = browser()
  sessionMemory[SESSION_KEY] = { token: TOKEN, expires_at: future() }
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json(proAccount()))
  assert.equal((await accountModule.accountSnapshot()).pro, true)
  fetchMock.mock.mockImplementation(async () => Response.json({ detail: 'revoked' }, { status: 401 }))
  await assert.rejects(accountModule.accountSnapshot(), /revoked/)
  assert.equal(sessionMemory[SESSION_KEY], undefined)
  sessionMemory[SESSION_KEY] = { token: TOKEN, expires_at: '2000-01-01T00:00:00Z' }
  await assert.rejects(accountModule.accountSnapshot(), /expired/)
  assert.equal(sessionMemory[SESSION_KEY], undefined)
  assert.equal((await accountModule.accountSnapshot()).pro, false)
})

test('network failures deny authorization, and sign-out clears this browser even if server revocation fails', async () => {
  const { sessionMemory } = browser()
  sessionMemory[SESSION_KEY] = { token: TOKEN, expires_at: future() }
  mock.method(globalThis, 'fetch', async () => { throw new TypeError('Network unavailable') })
  await assert.rejects(accountModule.handleAccountAction('authorize'), /Network unavailable/)
  await assert.rejects(accountModule.handleAccountAction('signout'), /Network unavailable/)
  assert.equal(sessionMemory[SESSION_KEY], undefined)
})

test('confirmed server account deletion clears only the account session after success', async () => {
  const { sessionMemory, localMemory } = browser()
  sessionMemory[SESSION_KEY] = { token: TOKEN, expires_at: future() }
  localMemory['devtoolbox.workspaces.v1'] = { version: 1, revision: 1, workspaces: [] }
  const originalWorkspaces = structuredClone(localMemory)
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Provider unavailable' }, { status: 502 }))
  await assert.rejects(accountModule.handleAccountAction('delete'), /Provider unavailable/)
  assert.ok(sessionMemory[SESSION_KEY])
  fetchMock.mock.mockImplementation(async (url, options) => {
    assert.ok(url.endsWith('/delete/'))
    assert.deepEqual(JSON.parse(options.body), { confirmation: 'DELETE' })
    return new Response(null, { status: 204 })
  })
  assert.equal((await accountModule.handleAccountAction('delete')).signedIn, false)
  assert.equal(sessionMemory[SESSION_KEY], undefined)
  assert.deepEqual(localMemory, originalWorkspaces)
})

test('test checkout and portal open only validated Stripe hosts and do not grant access', async () => {
  const { chrome, sessionMemory } = browser()
  sessionMemory[SESSION_KEY] = { token: TOKEN, expires_at: future() }
  const create = mock.method(chrome.tabs, 'create')
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ url: 'https://checkout.stripe.com/c/pay/test' }))
  assert.deepEqual(await accountModule.handleAccountAction('checkout'), { opened: true })
  assert.equal(create.mock.callCount(), 1)
  assert.deepEqual(Object.keys(sessionMemory[SESSION_KEY]).sort(), ['expires_at', 'token'])
  fetchMock.mock.mockImplementation(async () => Response.json({ url: 'https://checkout.stripe.com.evil.example/pay' }))
  await assert.rejects(accountModule.handleAccountAction('checkout'), /Unexpected Stripe/)
  assert.equal(create.mock.callCount(), 1)
  fetchMock.mock.mockImplementation(async () => Response.json({ url: 'https://billing.stripe.com/p/session/test' }))
  assert.deepEqual(await accountModule.handleAccountAction('portal'), { opened: true })
  assert.equal(create.mock.callCount(), 2)
})

test('invalid or expired server entitlements are rejected', () => {
  for (const account of [
    { ...proAccount(), billing_mode: 'live' },
    { ...proAccount(), pro_until: '2000-01-01T00:00:00Z' },
    { ...proAccount(), pro: 'true' },
  ]) assert.throws(() => accountModule.validateAccount(account), /invalid|expired/)
})

test('account-enabled worker verifies server access, ignores forged UI Pro flags and preserves export/delete after revocation', async () => {
  const { sessionMemory, localMemory, send } = browser()
  sessionMemory[SESSION_KEY] = { token: TOKEN, expires_at: future() }
  const errors = mock.method(console, 'error', () => {})
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json(proAccount()))
  await server.ssrLoadModule('/src/background.js')
  const channel = 'devtoolbox.workspaces.v1'
  const workspace = {
    id: 'a', name: 'API', baseline: '{}', current: '{}', ignores: '/id',
    redaction: '', root: 'ApiResponse', extra: 'ignore', updatedAt: new Date().toISOString(),
  }
  assert.equal((await send({ channel, action: 'save', revision: 0, workspace })).ok, true)
  fetchMock.mock.mockImplementation(async () => Response.json(freeAccount()))
  const denied = await send({ channel, action: 'save', revision: 1, workspace: { ...workspace, id: 'b' }, pro: true })
  assert.equal(denied.ok, false)
  assert.match(denied.error, /one saved workspace/)
  const spoofedSender = await send({ channel, action: 'read' }, { id: 'test', url: 'chrome-extension://test/index.html.evil' })
  assert.equal(spoofedSender.ok, false)
  fetchMock.mock.mockImplementation(async () => { throw new TypeError('Offline') })
  assert.equal((await send({ channel, action: 'read' })).ok, true)
  assert.equal((await send({ channel, action: 'export' })).ok, true)
  assert.equal((await send({ channel, action: 'save', revision: 1, workspace })).ok, false)
  assert.equal((await send({ channel, action: 'delete', revision: 1, id: 'a' })).ok, true)
  assert.equal(localMemory[channel].workspaces.length, 0)
  assert.ok(errors.mock.callCount() > 0)
})
