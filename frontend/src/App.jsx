import { useEffect, useMemo, useRef, useState } from 'react'
import { fetchGreeting } from './api'
import Notes from './Notes'
import Workspace from './Workspace.jsx'
import { isFullPageView, isSidePanelView } from './extensionViews.js'
import { viewRequest } from './viewSessions.js'

const cloudBuild = import.meta.env?.VITE_CLOUD_BUILD === 'true'

export default function App({ initialSnapshot, viewContext, viewReady = true, viewFailure, onReady, onRetry }) {
  const [message, setMessage] = useState(initialSnapshot?.app.message ?? '')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(initialSnapshot?.app.error ?? '')
  const [panelError, setPanelError] = useState('')
  const [pageError, setPageError] = useState('')
  const [fullPage] = useState(() => viewContext ? viewContext.mode === 'full-page' : isFullPageView(globalThis.window))
  const [sidePanel] = useState(() => viewContext ? viewContext.mode === 'side-panel' : isSidePanelView(globalThis.window))
  const [localToolsOpen, setLocalToolsOpen] = useState(initialSnapshot?.app.localToolsOpen ?? false)
  const [workspaceDraft, setWorkspaceDraft] = useState(initialSnapshot?.workspace ?? null)
  const [notesDraft, setNotesDraft] = useState(initialSnapshot?.notes ?? null)
  const [confirmed, setConfirmed] = useState(null)
  const [syncAttempt, setSyncAttempt] = useState(0)
  const [syncError, setSyncError] = useState('')
  const [switching, setSwitching] = useState(false)
  const workspaceRef = useRef(null)
  const notesRef = useRef(null)
  const snapshot = useMemo(() => ({
    app: { message, error, localToolsOpen }, workspace: workspaceDraft, notes: cloudBuild ? null : notesDraft,
  }), [message, error, localToolsOpen, workspaceDraft, notesDraft])
  const synced = confirmed?.snapshot === snapshot && !syncError

  useEffect(() => { onReady?.() }, [onReady])

  useEffect(() => {
    if (!viewContext || !viewReady || switching || !workspaceDraft || (!cloudBuild && !notesDraft)) return
    let active = true
    const json = JSON.stringify(snapshot)
    viewRequest({
      action: 'save', windowId: viewContext.windowId, contextId: viewContext.contextId, snapshot,
    }).then(result => {
      if (active) {
        setConfirmed({ snapshot, json, revision: result.revision })
        setSyncError('')
      }
    }).catch(failure => {
      console.error('Temporary draft sync failed:', failure.name)
      if (active) setSyncError(failure.message)
    })
    return () => { active = false }
  }, [snapshot, workspaceDraft, notesDraft, viewContext, viewReady, switching, syncAttempt])

  async function changeView(target, setViewError) {
    setViewError('')
    try {
      if (!viewContext) throw new Error('Load the rebuilt extension in Chrome to switch workspace views.')
      if (fullPage && !chrome.extension.getViews({ type: 'tab', windowId: viewContext.windowId }).includes(window)) {
        throw new Error('This tab moved to another Chrome window. Keep this view open and save your workspace before reopening there.')
      }
      if (loading || workspaceRef.current?.busy || notesRef.current?.busy) {
        throw new Error('Wait for the current operation to finish before switching views.')
      }
      const current = {
        app: { message, error, localToolsOpen },
        workspace: workspaceRef.current.draft, notes: cloudBuild ? null : notesRef.current.draft,
      }
      if (!synced || workspaceRef.current.draft !== workspaceDraft ||
        (!cloudBuild && notesRef.current.draft !== notesDraft) || confirmed?.json !== JSON.stringify(current)) {
        throw new Error('The current draft is still syncing in browser memory. Try again in a moment.')
      }
      setSwitching(true)
      const opening = viewRequest({
        action: 'open', windowId: viewContext.windowId, contextId: viewContext.contextId, target, revision: confirmed.revision,
      })
      // Do not await storage or messaging before this API: Chrome requires the original click gesture.
      const panel = target === 'side-panel' ? chrome.sidePanel.open({ windowId: viewContext.windowId }) : undefined
      await Promise.all([opening, panel])
    } catch (failure) {
      console.error('View switching failed:', failure.name)
      setViewError(failure.message)
      setSwitching(false)
    }
  }

  async function handleFetch() {
    setLoading(true)
    setError('')
    setMessage('Connecting...')
    try {
      setMessage(await fetchGreeting())
    } catch (failure) {
      console.error('Greeting request failed:', failure.name)
      setError(failure.name === 'TimeoutError'
        ? 'Request timed out. Check that Django is running.'
        : failure instanceof TypeError ? 'Cannot reach Django. Check the server and extension permissions.'
          : failure.message)
      setMessage('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main>
      <header><h1>DevToolBox <small>v1.1</small></h1>
        <div className="view-actions">
          <div className="view-action">
            <button type="button" className="secondary" disabled={switching || !viewReady || (viewContext && !synced)}
              onClick={() => changeView(sidePanel ? 'popup' : 'side-panel', setPanelError)}
              title={sidePanel ? 'Return this workspace to the toolbar popup.' : 'Move this workspace into the side panel, keeping its values.'}
              aria-describedby={panelError ? 'side-panel-error' : undefined}>{sidePanel ? 'Exit side panel' : 'Open side panel'}</button>
            {panelError && <p id="side-panel-error" className="error view-error" role="alert">{panelError}</p>}
          </div>
          <div className="view-action">
            <button type="button" className="secondary" disabled={switching || !viewReady || (viewContext && !synced)}
              onClick={() => changeView(fullPage ? 'popup' : 'full-page', setPageError)}
              title={fullPage ? 'Return this workspace to the toolbar popup.' : 'Move this workspace into a full-page tab, keeping its values.'}
              aria-describedby={pageError ? 'full-page-error' : undefined}>{fullPage ? 'Exit full page' : 'Open full page'}</button>
            {pageError && <p id="full-page-error" className="error view-error" role="alert">{pageError}</p>}
          </div>
        </div>
      </header>
      {syncError && <div className="view-actions">
        <p className="error view-error" role="alert">View switching paused: {syncError}</p>
        <div className="view-action"><button type="button" className="secondary"
          onClick={() => setSyncAttempt(attempt => attempt + 1)}>Retry draft sync</button></div>
      </div>}
      {viewFailure && <div><p className="error view-error" role="alert">{viewFailure}</p>
        <button type="button" className="secondary" onClick={onRetry}>Retry view switch</button></div>}
      <fieldset disabled={switching || !viewReady}>
      <Workspace ref={workspaceRef} initialDraft={initialSnapshot?.workspace} onDraftChange={setWorkspaceDraft} />
      {error && <p className="error" role="alert">{error}</p>}
      {!cloudBuild && <details className="local-tools" open={localToolsOpen}
        onToggle={event => setLocalToolsOpen(event.currentTarget.open)}><summary>Local backend and notes</summary>
        <button type="button" onClick={handleFetch} disabled={loading}>Fetch from Backend</button>
        <p role="status">{message}</p>
        <Notes ref={notesRef} initialDraft={initialSnapshot?.notes} onDraftChange={setNotesDraft} />
      </details>}
      </fieldset>
    </main>
  )
}
