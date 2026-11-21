import { useState } from 'react'
import { fetchGreeting } from './api'
import Notes from './Notes'
import Workspace from './Workspace.jsx'
import { openFullPage, openSidePanel } from './extensionViews.js'

const cloudBuild = import.meta.env?.VITE_CLOUD_BUILD === 'true'

export default function App() {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [panelError, setPanelError] = useState('')
  const [pageError, setPageError] = useState('')

  async function openPanel() {
    setPanelError('')
    try {
      await openSidePanel()
    } catch (failure) {
      console.error('Side panel failed:', failure.name)
      setPanelError(failure.message)
    }
  }

  async function openPage() {
    setPageError('')
    try {
      await openFullPage()
    } catch (failure) {
      console.error('Full-page view failed:', failure.name)
      setPageError(failure.message)
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
            <button type="button" className="secondary" onClick={openPanel}
              aria-describedby={panelError ? 'side-panel-error' : undefined}>Open side panel</button>
            {panelError && <p id="side-panel-error" className="error view-error" role="alert">{panelError}</p>}
          </div>
          <div className="view-action">
            <button type="button" className="secondary" onClick={openPage}
              title="Opens a new workspace view. Save a workspace first to keep drafts."
              aria-describedby={pageError ? 'full-page-error' : undefined}>Open full page</button>
            {pageError && <p id="full-page-error" className="error view-error" role="alert">{pageError}</p>}
          </div>
        </div>
      </header>
      <Workspace />
      {error && <p className="error" role="alert">{error}</p>}
      {!cloudBuild && <details className="local-tools"><summary>Local backend and notes</summary>
        <button type="button" onClick={handleFetch} disabled={loading}>Fetch from Backend</button>
        <p role="status">{message}</p>
        <Notes />
      </details>}
    </main>
  )
}
