import { useState } from 'react'
import { fetchGreeting } from './api'
import Notes from './Notes'
import { scrapeHighlightedText } from './selection'
import { convertLogToCsv, formatJson } from './tools'
import { downloadText } from './download'

const cloudBuild = import.meta.env?.VITE_CLOUD_BUILD === 'true'

export default function App() {
  const [message, setMessage] = useState('Ready to connect.')
  const [isLoading, setIsLoading] = useState(false)
  const [hasError, setHasError] = useState(false)
  const [inputText, setInputText] = useState('')
  const [toolBusy, setToolBusy] = useState(false)
  const [toolError, setToolError] = useState('')
  const [toolStatus, setToolStatus] = useState('')

  async function runTool(action) {
    setToolBusy(true)
    setToolError('')
    setToolStatus('')
    try {
      await action()
    } catch (error) {
      console.error(
        'Developer tool failed:', error instanceof Error ? error.name : 'UnknownError',
      )
      setToolError(
        error?.name === 'TimeoutError'
          ? 'Request timed out. Check the backend and try again.'
          : error instanceof Error ? error.message : 'Unexpected tool failure.',
      )
    } finally {
      setToolBusy(false)
    }
  }

  function captureSelection() {
    return runTool(async () => {
      setInputText(await scrapeHighlightedText())
      setToolStatus('Highlighted text copied into the input. Nothing was uploaded.')
    })
  }

  function downloadCsv() {
    return runTool(async () => {
      const csv = await convertLogToCsv(inputText)
      downloadText('\uFEFF' + csv, 'logs.csv', 'text/csv;charset=utf-8')
      setToolStatus('CSV download requested. Check Chrome Downloads.')
    })
  }

  async function handleFetch() {
    setIsLoading(true)
    setHasError(false)
    setMessage('Connecting...')

    try {
      setMessage(await fetchGreeting())
    } catch (error) {
      console.error('Greeting request failed:', error)
      setHasError(true)

      if (error instanceof Error && error.name === 'TimeoutError') {
        setMessage('Request timed out. Check that Django is running.')
      } else if (error instanceof TypeError) {
        setMessage(
          'Cannot reach Django. Check the server and extension permissions.',
        )
      } else {
        setMessage(
          error instanceof Error ? error.message : 'Unexpected request failure.',
        )
      }
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main aria-busy={isLoading}>
      <h1>Developer tools</h1>
      <section aria-label="JSON and log tools" aria-busy={toolBusy}>
        <label htmlFor="tool-input">JSON or log input</label>
        <textarea
          id="tool-input"
          rows={7}
          value={inputText}
          onChange={(event) => setInputText(event.target.value)}
          disabled={toolBusy}
          aria-describedby="tool-privacy"
        />
        <p id="tool-privacy" className="hint">
          JSON formatting and capture stay in this popup. CSV conversion sends
          your input to {cloudBuild ? 'the configured HTTPS server' : 'local Django'}.
          Do not send secrets or sensitive logs.
        </p>
        <button type="button" onClick={captureSelection} disabled={toolBusy}>
          Scrape Highlighted Text
        </button>
        <div className="note-actions">
          <button
            type="button"
            className="secondary"
            disabled={toolBusy || !inputText.trim()}
            onClick={() => runTool(async () => {
              setInputText(formatJson(inputText))
              setToolStatus('JSON formatted locally.')
            })}
          >
            Format JSON
          </button>
          <button
            type="button"
            className="secondary"
            onClick={downloadCsv}
            disabled={toolBusy || !inputText.trim()}
          >
            Download CSV
          </button>
        </div>
        {toolError && <p className="error" role="alert">{toolError}</p>}
        <p role="status" aria-live="polite">{toolStatus}</p>
      </section>
      {!cloudBuild && <>
      <button type="button" onClick={handleFetch} disabled={isLoading}>
        Fetch from Backend
      </button>
      <p
        className={hasError ? 'message error' : 'message'}
        role="status"
        aria-live="polite"
      >
        {message}
      </p>
      <Notes />
      </>}
    </main>
  )
}
