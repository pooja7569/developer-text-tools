import { useState } from 'react'
import { fetchGreeting } from './api'
import Notes from './Notes'
import Workspace from './Workspace.jsx'

const cloudBuild = import.meta.env?.VITE_CLOUD_BUILD === 'true'

export default function App() {
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function openPanel() {
    setError('')
    try {
      if (!globalThis.chrome?.sidePanel) throw new Error('Side panel requires Chrome 116 or newer and the loaded extension.')
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.windowId) throw new Error('No active Chrome window.')
      await chrome.sidePanel.open({ windowId: tab.windowId })
    } catch (failure) {
      console.error('Side panel failed:', failure.name)
      setError(failure.message)
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
        <button type="button" className="secondary" onClick={openPanel}>Open side panel</button></header>
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
