import { emptyStore, mutateStore, proPreview, STORAGE_KEY, validateStore } from './workspaces.js'
import { ACCOUNT_CHANNEL, accountSnapshot, handleAccountAction } from './account.js'

let queue = Promise.resolve()
let accountQueue = Promise.resolve()

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request?.channel !== STORAGE_KEY && request?.channel !== ACCOUNT_CHANNEL) return false
  if (sender.id !== chrome.runtime.id ||
    sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('index.html')) {
    sendResponse({ ok: false, error: 'Workspace requests require the extension workspace page.' })
    return false
  }
  if (request.channel === ACCOUNT_CHANNEL) {
    accountQueue = accountQueue.then(() => handleAccountAction(request.action)).then(
      (account) => sendResponse({ ok: true, account }),
      (error) => {
        console.error('Account operation failed:', error.name)
        sendResponse({ ok: false, error: error.message })
      },
    )
    return true
  }
  const operation = queue.then(async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    if (request.action === 'export') {
      return { backup: JSON.stringify(stored[STORAGE_KEY] ?? emptyStore(), null, 2) }
    }
    const current = Object.hasOwn(stored, STORAGE_KEY) ? validateStore(stored[STORAGE_KEY]) : emptyStore()
    if (request.action === 'read') return current
    const allowPro = proPreview || (request.action !== 'delete' && (await accountSnapshot()).pro)
    const next = mutateStore(current, request, allowPro)
    await chrome.storage.local.set({ [STORAGE_KEY]: next })
    return next
  })
  queue = operation.then(
    (store) => sendResponse(store.backup !== undefined
      ? { ok: true, backup: store.backup } : { ok: true, store }),
    (error) => {
      console.error('Workspace operation failed:', error.name)
      sendResponse({ ok: false, error: error.message })
    },
  )
  return true
})
