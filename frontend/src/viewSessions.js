export const VIEW_CHANNEL = 'devtoolbox-view-session-v1'
export const VIEW_EVENTS = `${VIEW_CHANNEL}-events`
const modes = { POPUP: 'popup', TAB: 'full-page', SIDE_PANEL: 'side-panel' }
const sessionKey = windowId => `${VIEW_CHANNEL}:${windowId}`

export async function viewRequest(request) {
  const response = await chrome.runtime.sendMessage({ channel: VIEW_CHANNEL, ...request })
  if (!response?.ok) throw new Error(response?.error ||
    'The background worker did not acknowledge this request. Reload DevToolBox at chrome://extensions and retry.')
  return response.view
}

function validateSnapshot(snapshot) {
  const workspace = snapshot?.workspace
  if (!workspace || !['Tools', 'Compare', 'Generate', 'Workspaces'].includes(workspace.tab) ||
    !['json', 'json-yaml', 'yaml-json', 'jwt', 'csv'].includes(workspace.tool) ||
    ['input', 'baseline', 'output', 'extension', 'error', 'status', 'search', 'ignores',
      'redaction', 'root', 'extra', 'selected', 'name'].some(key => typeof workspace[key] !== 'string') ||
    !Array.isArray(workspace.rows) || !snapshot.app ||
    typeof snapshot.app.message !== 'string' || typeof snapshot.app.error !== 'string' ||
    typeof snapshot.app.localToolsOpen !== 'boolean') {
    throw new Error('The current workspace cannot be transferred. Keep this view open and retry.')
  }
  if (snapshot.notes !== null && (!snapshot.notes || !Array.isArray(snapshot.notes.notes) ||
    ['query', 'text', 'editText', 'status', 'error'].some(key => typeof snapshot.notes[key] !== 'string'))) {
    throw new Error('The current note drafts cannot be transferred.')
  }
  return snapshot
}

async function workspaceContexts() {
  const entry = chrome.runtime.getURL('index.html')
  return (await chrome.runtime.getContexts({})).filter(context =>
    modes[context.contextType] && context.documentUrl?.split(/[?#]/)[0] === entry)
}

async function senderContext(sender, windowId, request) {
  const contexts = await workspaceContexts()
  const candidates = contexts.filter(item => {
    if (sender.documentId) return item.documentId === sender.documentId
    if (item.documentUrl !== sender.url) return false
    if (request.contextId) return item.contextId === request.contextId
    return modes[item.contextType] === request.mode &&
      (item.windowId === windowId || item.windowId === -1) &&
      (!sender.tab || item.tabId === sender.tab.id)
  })
  const context = candidates.length === 1 ? candidates[0] : null
  if (!context || !Number.isInteger(windowId) || windowId < 0 ||
    (request.contextId && context.contextId !== request.contextId)) {
    throw new Error('View switching requires this extension in its own Chrome window.')
  }
  if (context.windowId >= 0 && context.windowId !== windowId) {
    throw new Error(request.action === 'restore'
      ? 'View switching requires this extension in its own Chrome window.'
      : 'This workspace moved to a different Chrome window. Its current values have been kept in this view.')
  }
  return {
    contextId: context.contextId, documentId: context.documentId,
    mode: modes[context.contextType], tabId: context.tabId, windowId,
  }
}

async function writeSession(windowId, session) {
  await chrome.storage.session.set({ [sessionKey(windowId)]: session })
}

async function rememberPage(session, windowId, contexts) {
  const [tab] = await chrome.tabs.query({ active: true, windowId })
  if (tab && !contexts.some(context => context.tabId === tab.id)) session.returnTabId = tab.id
}

async function returnToPage(session, windowId, contexts) {
  const tabs = (await chrome.tabs.query({ windowId })).filter(tab =>
    !contexts.some(context => context.tabId === tab.id))
  const page = tabs.find(tab => tab.id === session.returnTabId) || tabs.find(tab => tab.active) || tabs[0]
  const target = page || await chrome.tabs.create({ windowId, active: true })
  await chrome.tabs.update(target.id, { active: true })
  session.returnTabId = target.id
}

async function notifyContext(contextId, action) {
  const response = await chrome.runtime.sendMessage({ channel: VIEW_EVENTS, contextId, action })
  if (!response?.ok) throw new Error('The previous view did not acknowledge the switch. Retry view switching.')
}

async function closePrevious(previous, current, session) {
  if (!previous || previous.contextId === current.contextId) return
  const context = (await workspaceContexts()).find(item => item.contextId === previous.contextId)
  if (!context) return
  if (modes[context.contextType] !== previous.mode ||
    (context.windowId >= 0 && context.windowId !== previous.windowId)) {
    throw new Error('Chrome could not verify the previous extension view. It has been kept open.')
  }
  if (previous.mode === 'full-page') {
    if (context.contextType !== 'TAB' || context.tabId !== previous.tabId) {
      throw new Error('Chrome could not verify the previous extension tab. It has been kept open.')
    }
    const [active] = await chrome.tabs.query({ active: true, windowId: current.windowId })
    const reopenPopup = current.mode === 'popup' && active?.id === previous.tabId
    if (current.mode === 'side-panel' || reopenPopup) {
      await returnToPage(session, current.windowId, await workspaceContexts())
    }
    await chrome.tabs.remove(context.tabId)
    if (reopenPopup) await chrome.action.openPopup({ windowId: current.windowId })
  } else if (previous.mode === 'side-panel') {
    await chrome.sidePanel.close({ windowId: previous.windowId })
    // Closing the panel can move Chrome's focus and dismiss the restored popup.
    if (current.mode === 'popup' &&
      !(await workspaceContexts()).some(item => item.contextId === current.contextId)) {
      await chrome.action.openPopup({ windowId: current.windowId })
    }
  } else {
    try {
      await notifyContext(previous.contextId, 'close')
    } catch (failure) {
      if ((await workspaceContexts()).some(item => item.contextId === previous.contextId)) throw failure
    }
  }
}

export async function handleViewAction(request, sender) {
  if (!chrome.storage?.session || !chrome.runtime.getContexts ||
    !chrome.action?.openPopup || !chrome.sidePanel?.close) {
    throw new Error('Seamless view switching requires Chrome 141 or newer.')
  }
  if (!Number.isInteger(request.windowId) || request.windowId < 0) {
    throw new Error('No Chrome window is available for this workspace.')
  }
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  const key = sessionKey(request.windowId)
  const stored = await chrome.storage.session.get(key)
  const session = stored[key] || {
    snapshot: null, revision: 0, owner: null, pending: null, returnTabId: null, readyContexts: [],
  }

  if (request.action === 'restore') {
    const context = await senderContext(sender, request.windowId, request)
    const contexts = await workspaceContexts()
    session.readyContexts = session.readyContexts.filter(id => contexts.some(item => item.contextId === id))
    if (session.pending && session.pending.current.contextId !== context.contextId &&
      contexts.some(item => item.contextId === session.pending.current.contextId)) {
      throw new Error('Another view is still restoring this workspace. Retry when it finishes.')
    }
    if (!session.pending) {
      session.pending = { id: crypto.randomUUID(), current: context, previous: session.owner }
    } else {
      session.pending.current = context
    }
    if (context.mode !== 'full-page') await rememberPage(session, request.windowId, contexts)
    await writeSession(request.windowId, session)
    return { context, snapshot: session.snapshot, transferId: session.pending.id }
  }

  if (request.action === 'ready') {
    const context = await senderContext(sender, request.windowId, request)
    if (!session.pending && session.owner?.contextId === context.contextId) return { revision: session.revision }
    if (session.pending?.id !== request.transferId || session.pending.current.contextId !== context.contextId) {
      throw new Error('This view switch is no longer current. Restore the workspace again.')
    }
    session.owner = context
    await writeSession(request.windowId, session)
    await closePrevious(session.pending.previous, context, session)
    session.pending = null
    if (!session.readyContexts.includes(context.contextId)) session.readyContexts.push(context.contextId)
    await writeSession(request.windowId, session)
    return { revision: session.revision }
  }

  if (!session.owner) {
    throw new Error('This workspace is active in another view. Continue there instead.')
  }
  const caller = await senderContext(sender, request.windowId, request)
  if (session.owner.contextId !== caller.contextId) {
    throw new Error('This workspace is active in another view. Continue there instead.')
  }
  if (session.pending) throw new Error('A view switch is still restoring the workspace.')

  if (request.action === 'save') {
    session.snapshot = validateSnapshot(request.snapshot)
    session.revision += 1
    await writeSession(request.windowId, session)
    return { revision: session.revision }
  }

  if (request.action === 'open') {
    if (!session.snapshot || !['popup', 'full-page', 'side-panel'].includes(request.target) ||
      request.target === session.owner.mode || request.revision !== session.revision) {
      throw new Error('Wait for the current draft to finish syncing before switching views.')
    }
    const contexts = await workspaceContexts()
    if (session.owner.mode !== 'full-page') await rememberPage(session, request.windowId, contexts)
    await writeSession(request.windowId, session)
    const target = contexts.find(context => modes[context.contextType] === request.target &&
      (context.windowId === request.windowId ||
        (context.windowId === -1 && session.readyContexts.includes(context.contextId))))
    if (request.target === 'full-page') {
      if (target) await chrome.tabs.update(target.tabId, { active: true })
      else await chrome.tabs.create({ windowId: request.windowId, url: chrome.runtime.getURL('index.html'), active: true })
    } else if (request.target === 'popup') {
      await returnToPage(session, request.windowId, contexts)
      await writeSession(request.windowId, session)
      await chrome.action.openPopup({ windowId: request.windowId })
    }
    // Side-panel opening is performed synchronously by the clicked button to retain Chrome's user gesture.
    if (target && session.readyContexts.includes(target.contextId)) {
      await notifyContext(target.contextId, 'restore')
    }
    return { opened: true }
  }
  throw new Error('Unknown workspace view operation.')
}

export async function clearWindowSession(windowId) {
  await chrome.storage.session.remove(sessionKey(windowId))
}
