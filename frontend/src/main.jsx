import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { isPopupView, isSidePanelView } from './extensionViews.js'
import { VIEW_EVENTS, viewRequest } from './viewSessions.js'

if (isPopupView(window)) document.documentElement.classList.add('extension-popup')

const root = createRoot(document.getElementById('root'))
let context
let generation = 0

async function restoreView() {
  const currentGeneration = ++generation
  root.render(<main><p role="status">Restoring workspace...</p></main>)
  try {
    const browserWindow = await chrome.windows.getCurrent()
    const mode = isPopupView(window) ? 'popup' : isSidePanelView(window) ? 'side-panel' : 'full-page'
    const restored = await viewRequest({ action: 'restore', windowId: browserWindow.id, mode })
    if (currentGeneration !== generation) return
    context = restored.context
    let completing = false
    const render = (ready, failure) => root.render(
      <StrictMode><App key={currentGeneration} initialSnapshot={restored.snapshot} viewContext={context}
        viewReady={ready} viewFailure={failure} onReady={complete} onRetry={restoreView} /></StrictMode>,
    )
    async function complete() {
      if (completing) return
      completing = true
      try {
        await viewRequest({
          action: 'ready', windowId: context.windowId, contextId: context.contextId, transferId: restored.transferId,
        })
        if (currentGeneration === generation) render(true)
      } catch (failure) {
        console.error('Completing view switch failed:', failure.name)
        if (currentGeneration === generation) render(false, `Workspace restored, but the previous view could not be closed. ${failure.message}`)
      }
    }
    render(false)
  } catch (failure) {
    console.error('Restoring workspace failed:', failure.name)
    if (currentGeneration === generation) root.render(<main><h1>DevToolBox</h1>
      <p className="error" role="alert">{failure.message}</p>
      <button type="button" onClick={restoreView}>Retry restoring workspace</button></main>)
  }
}

if (globalThis.chrome?.runtime?.id) {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.channel !== VIEW_EVENTS || request.contextId !== context?.contextId ||
      sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('background.js')) return false
    if (request.action === 'close') {
      sendResponse({ ok: true })
      window.close()
    } else if (request.action === 'restore') {
      sendResponse({ ok: true })
      restoreView()
    } else return false
    return false
  })
  restoreView()
} else {
  root.render(<StrictMode><App /></StrictMode>)
}
