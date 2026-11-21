export const ACCOUNT_CHANNEL = 'devtoolbox.account.v1'
export const accountsEnabled = import.meta.env?.VITE_ACCOUNTS_ENABLED === 'true'
const SESSION_KEY = 'devtoolbox.account.session'
const ORIGIN = import.meta.env?.VITE_TOOLS_API_ORIGIN ?? 'http://127.0.0.1:8000'

function sessionStorage() {
  const storage = globalThis.chrome?.storage?.session
  if (!storage) throw new Error('Accounts require Chrome session storage in the installed extension.')
  return storage
}

async function savedSession() {
  const storage = sessionStorage()
  await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  const value = (await storage.get(SESSION_KEY))[SESSION_KEY]
  if (!value) return null
  if (typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
    !Number.isFinite(Date.parse(value.expires_at))) {
    await storage.remove(SESSION_KEY)
    throw new Error('Invalid account session was removed. Sign in again.')
  }
  if (Date.parse(value.expires_at) <= Date.now()) {
    await storage.remove(SESSION_KEY)
    throw new Error('Your session expired. Sign in again.')
  }
  return value
}

async function api(path, { method = 'POST', data, token } = {}) {
  const response = await fetch(`${ORIGIN}/api/account/${path}/`, {
    method, headers: {
      Accept: 'application/json', 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : method === 'POST' ? { body: '{}' } : {}),
    credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(45000),
  })
  if (response.status === 401) {
    await sessionStorage().remove(SESSION_KEY)
    throw new Error('Session expired or revoked. Sign in again.')
  }
  if (!response.ok) {
    const body = response.headers.get('Content-Type')?.includes('application/json') ? await response.json() : null
    throw new Error(typeof body?.detail === 'string' ? body.detail : `Account request failed (HTTP ${response.status}).`)
  }
  if (response.status === 204) return null
  return response.json()
}

export function validateAccount(account) {
  if (!account || typeof account.email !== 'string' || typeof account.pro !== 'boolean' ||
    !['test', 'disabled'].includes(account.billing_mode) ||
    typeof account.subscription_status !== 'string' ||
    !(account.pro_until === null || (typeof account.pro_until === 'string' && Number.isFinite(Date.parse(account.pro_until))))) {
    throw new Error('Server returned invalid account information.')
  }
  if (account.pro && (account.billing_mode !== 'test' || !account.pro_until || Date.parse(account.pro_until) <= Date.now())) {
    throw new Error('Server returned an expired or invalid test entitlement.')
  }
  return {
    email: account.email, pro: account.pro, pro_until: account.pro_until,
    subscription_status: account.subscription_status, billing_mode: account.billing_mode,
  }
}

export async function accountSnapshot() {
  if (!accountsEnabled) return { enabled: false, signedIn: false, pro: false }
  const session = await savedSession()
  if (!session) return { enabled: true, signedIn: false, pro: false }
  const account = validateAccount(await api('me', { method: 'GET', token: session.token }))
  return { ...account, enabled: true, signedIn: true }
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function handleAccountAction(action) {
  if (!accountsEnabled) throw new Error('Accounts are not enabled in this build. Follow the account setup guide.')
  if (action === 'status' || action === 'authorize') return accountSnapshot()
  if (action === 'signin') {
    if (!chrome.identity?.launchWebAuthFlow) throw new Error('Google sign-in requires the extension identity permission.')
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
    const redirectUri = chrome.identity.getRedirectURL('auth')
    const start = await api('google/start', { data: { challenge, redirect_uri: redirectUri } })
    const googleUrl = new URL(start.url)
    if (googleUrl.origin !== 'https://accounts.google.com' || googleUrl.pathname !== '/o/oauth2/v2/auth') {
      throw new Error('Server returned an unexpected sign-in URL.')
    }
    const callback = await chrome.identity.launchWebAuthFlow({ url: start.url, interactive: true })
    const finish = new URL(callback)
    if (finish.origin + finish.pathname !== redirectUri || finish.search) throw new Error('Invalid sign-in callback.')
    const ticket = new URLSearchParams(finish.hash.slice(1)).get('ticket')
    if (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('Sign-in did not return a valid one-time ticket.')
    const session = await api('exchange', { data: { ticket, verifier } })
    if (!/^[A-Za-z0-9_-]{43}$/.test(session.token) ||
      !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.now()) {
      throw new Error('Invalid sign-in session response.')
    }
    validateAccount(session.account)
    const storage = sessionStorage()
    await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    await storage.set({ [SESSION_KEY]: { token: session.token, expires_at: session.expires_at } })
    return accountSnapshot()
  }
  const session = await savedSession()
  if (action === 'signout') {
    try {
      if (session) await api('logout', { token: session.token })
    } finally {
      await sessionStorage().remove(SESSION_KEY)
    }
    return { enabled: true, signedIn: false, pro: false }
  }
  if (!session) throw new Error('Sign in with Google first.')
  if (action === 'delete') {
    await api('delete', { token: session.token, data: { confirmation: 'DELETE' } })
    await sessionStorage().remove(SESSION_KEY)
    return { enabled: true, signedIn: false, pro: false }
  }
  if (action === 'checkout' || action === 'portal') {
    const response = await api(`billing/${action}`, { token: session.token })
    const url = new URL(response.url)
    const host = action === 'checkout' ? 'checkout.stripe.com' : 'billing.stripe.com'
    if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port) {
      throw new Error('Unexpected Stripe test billing URL.')
    }
    await chrome.tabs.create({ url: response.url })
    return { opened: true }
  }
  throw new Error('Unsupported account action.')
}

export async function accountRequest(action) {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Load the compiled extension to use accounts.')
  const response = await chrome.runtime.sendMessage({ channel: ACCOUNT_CHANNEL, action })
  if (!response?.ok) throw new Error(response?.error || 'Account service did not respond.')
  return response.account
}
