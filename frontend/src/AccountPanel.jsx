import { useEffect, useState } from 'react'
import { accountRequest } from './account.js'

export default function AccountPanel({ account, onChange }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let active = true
    accountRequest('status').then((value) => {
      if (active) onChange(value)
    }).catch((failure) => {
      console.error('Account refresh failed:', failure.name)
      if (active) { setError(failure.message); setExpanded(true) }
    })
    return () => { active = false }
  }, [onChange])

  async function act(action) {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const value = await accountRequest(action)
      if (value.opened) setMessage('Stripe TEST page opened. Use test card details only, then return and Refresh account/access.')
      else {
        onChange(value)
        setMessage(action === 'delete'
          ? 'Server account deleted and test subscriptions cancelled. Local workspaces and downloaded backups were kept.'
          : action === 'signout' ? 'Signed out. Saved workspaces were kept on this device.' : 'Account/access refreshed from the server.')
      }
    } catch (failure) {
      console.error('Account action failed:', failure.name)
      setExpanded(true)
      onChange(action === 'signout'
        ? { enabled: true, signedIn: false, pro: false }
        : { ...account, pro: false })
      setError(failure.message + (action === 'signout'
        ? ' This browser session was cleared; server revocation may have failed.' : ''))
    } finally {
      setBusy(false)
    }
  }

  return <details className="account-panel" aria-label="Account and test billing" aria-busy={busy}
    open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>Account <span className="badge">{account.pro ? 'Test Pro' : account.signedIn ? 'Free account' : 'Sign in / test billing'}</span></summary>
    <div className="account-content">
    <p className="hint">Google sign-in is optional. No real charges or bank account setup.
      Test subscriptions are not paid memberships. Use the side panel so sign-in does not close your workspace.</p>
    <p>{account.signedIn ? `${account.email} - ${account.pro ? 'Test Pro access' : 'Free access'}` : 'Not signed in.'}</p>
    {account.signedIn && <p className="hint">Subscription: {account.subscription_status}.
      {account.pro_until && ` Access until ${new Date(account.pro_until).toLocaleString()}.`}
      {' '}Sign-in expires after 12 hours or when Chrome closes.</p>}
    <div className="actions">
      {!account.signedIn && <button type="button" disabled={busy} onClick={() => act('signin')}>Sign in with Google</button>}
      <button type="button" className="secondary" disabled={busy} onClick={() => act('status')}>Refresh account/access</button>
      {account.signedIn && <>
        <button type="button" disabled={busy || account.billing_mode !== 'test' || account.pro}
          onClick={() => act('checkout')}>Start $1/month TEST checkout</button>
        <button type="button" className="secondary" disabled={busy || account.billing_mode !== 'test'}
          onClick={() => act('portal')}>Manage test subscription</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => act('signout')}>Sign out</button>
        <button type="button" className="danger" disabled={busy} onClick={() => {
          if (window.confirm('Delete this server account and cancel its TEST subscriptions permanently? Local workspaces and downloads will remain.')) {
            act('delete')
          }
        }}>Delete server account</button>
      </>}
    </div>
    <p className="hint">API payloads and workspaces are not uploaded for account or billing actions.
      Google supplies your verified identity/email. Stripe hosts checkout; never enter a real card in tests.</p>
    {error && <p className="error" role="alert">{error}</p>}
    <p role="status">{message}</p>
    </div>
  </details>
}
