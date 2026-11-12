import { useEffect, useState } from 'react'
import { createNote, deleteNote, fetchNotes, importNotesBackup, updateNote } from './api'
import { filterNotes } from './filterNotes'
import { exportNotesBackup, readNotesBackup } from './backup'

function errorMessage(error) {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'Request timed out. Check Django and refresh notes before retrying.'
  }
  if (error instanceof TypeError) {
    return 'Cannot reach Django. Check the server and refresh before retrying.'
  }
  return error instanceof Error ? error.message : 'Unexpected request failure.'
}

export default function Notes() {
  const [notes, setNotes] = useState([])
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isMutating, setIsMutating] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [isReadingBackup, setIsReadingBackup] = useState(false)
  const [pendingBackup, setPendingBackup] = useState(null)
  const [editingId, setEditingId] = useState(null)
  const [editText, setEditText] = useState('')
  const [deletingId, setDeletingId] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetchNotes()
      .then((data) => {
        if (active) setNotes(data)
      })
      .catch((failure) => {
        if (active) {
          console.error('Loading notes failed:', failure)
          setError(errorMessage(failure))
        }
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => { active = false }
  }, [])

  async function refreshNotes() {
    setIsLoading(true)
    setError('')
    setStatus('')
    try {
      setNotes(await fetchNotes())
      setStatus('Notes refreshed.')
    } catch (failure) {
      console.error('Refreshing notes failed:', failure)
      setError(errorMessage(failure))
    } finally {
      setIsLoading(false)
    }
  }

  async function saveNote(event) {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || text.length > 2000) {
      setError('Enter a note between 1 and 2,000 characters.')
      return
    }
    setIsMutating(true)
    setError('')
    setStatus('')
    try {
      const note = await createNote(trimmed)
      setNotes((previous) => [note, ...previous])
      setText('')
      setStatus('Note saved locally.')
    } catch (failure) {
      console.error('Saving note failed:', failure)
      setError(`${errorMessage(failure)} Your draft has been kept.`)
    } finally {
      setIsMutating(false)
    }
  }

  async function saveEdit(event) {
    event.preventDefault()
    const trimmed = editText.trim()
    if (!trimmed || editText.length > 2000) {
      setError('Enter a note between 1 and 2,000 characters.')
      return
    }
    setIsMutating(true)
    setError('')
    setStatus('')
    try {
      const updated = await updateNote(editingId, trimmed)
      setNotes((previous) => previous.map(
        (note) => note.id === updated.id ? updated : note,
      ))
      setEditingId(null)
      setEditText('')
      setStatus('Note updated locally.')
    } catch (failure) {
      console.error('Updating note failed:', failure)
      setError(`${errorMessage(failure)} Your edits have been kept.`)
    } finally {
      setIsMutating(false)
    }
  }

  async function confirmDelete(id) {
    setIsMutating(true)
    setError('')
    setStatus('')
    try {
      await deleteNote(id)
      setNotes((previous) => previous.filter((note) => note.id !== id))
      setDeletingId(null)
      setStatus('Note deleted locally.')
    } catch (failure) {
      console.error('Deleting note failed:', failure)
      setError(errorMessage(failure))
    } finally {
      setIsMutating(false)
    }
  }

  function cancelAction() {
    setEditingId(null)
    setDeletingId(null)
    setEditText('')
    setError('')
    setStatus('')
  }

  async function exportBackup() {
    setIsExporting(true)
    setError('')
    setStatus('')
    try {
      const count = await exportNotesBackup()
      setStatus(
        `Backup download requested for ${count} notes. Check Chrome Downloads.`,
      )
    } catch (failure) {
      console.error('Exporting notes failed:', failure)
      setError(`Backup export failed. ${errorMessage(failure)}`)
    } finally {
      setIsExporting(false)
    }
  }

  async function selectBackup(event) {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return
    setPendingBackup(null)
    setIsReadingBackup(true)
    setError('')
    setStatus('')
    try {
      const backup = await readNotesBackup(file)
      setPendingBackup({ name: file.name, backup })
    } catch (failure) {
      console.error('Reading backup failed:', failure)
      setError(failure instanceof Error ? failure.message : 'Could not read the backup.')
    } finally {
      setIsReadingBackup(false)
    }
  }

  async function confirmImport() {
    setIsMutating(true)
    setError('')
    setStatus('')
    try {
      const result = await importNotesBackup(pendingBackup.backup)
      setNotes(result.notes)
      setQuery('')
      setPendingBackup(null)
      setStatus(`Imported ${result.imported} notes; skipped ${result.skipped} duplicates.`)
    } catch (failure) {
      console.error('Importing notes failed:', failure)
      setError(`Import failed. ${errorMessage(failure)}`)
    } finally {
      setIsMutating(false)
    }
  }

  const busy = isLoading || isMutating || isExporting || isReadingBackup
  const actionOpen = editingId !== null || deletingId !== null || pendingBackup !== null
  const visibleNotes = filterNotes(notes, query)

  return (
    <section className="notes" aria-labelledby="notes-heading" aria-busy={busy}>
      <h2 id="notes-heading">My notes</h2>
      <p className="hint">Stored on this computer. Do not enter sensitive data.</p>
      <form onSubmit={saveNote}>
        <label htmlFor="note-text">New note</label>
        <textarea
          id="note-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={2000}
          rows={4}
          required
          disabled={isMutating}
          aria-describedby="note-limit"
        />
        <p id="note-limit" className="hint">{text.length}/2,000 characters</p>
        <button type="submit" disabled={busy || actionOpen || !text.trim()}>
          Save note
        </button>
      </form>
      <button
        type="button"
        className="secondary"
        onClick={refreshNotes}
        disabled={busy || actionOpen}
      >
        {isLoading ? 'Loading notes...' : 'Refresh notes'}
      </button>
      <button
        type="button"
        className="secondary"
        onClick={exportBackup}
        disabled={busy || actionOpen}
      >
        {isExporting ? 'Exporting...' : 'Export backup'}
      </button>
      <div className="note-import">
        <label htmlFor="backup-file">Import JSON backup</label>
        <input
          id="backup-file"
          type="file"
          accept=".json,application/json"
          onChange={selectBackup}
          disabled={busy || actionOpen}
          aria-describedby="import-help"
        />
        <p id="import-help" className="hint">
          Up to 1 MB and 500 notes. Existing notes are kept; identical text is skipped.
        </p>
        {isReadingBackup && <p role="status">Validating backup...</p>}
        {pendingBackup && (
          <div role="group" aria-label="Confirm backup import">
            <p>
              Import {pendingBackup.backup.notes.length} notes from {pendingBackup.name}?
              New notes receive new local IDs and creation times.
            </p>
            <div className="note-actions">
              <button type="button" onClick={confirmImport} disabled={busy}>
                {isMutating ? 'Importing...' : 'Confirm import'}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setPendingBackup(null)
                  setError('')
                  setStatus('')
                }}
              >
                Cancel import
              </button>
            </div>
          </div>
        )}
      </div>
      <p role="status" aria-live="polite">{status}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="note-search">
        <label htmlFor="note-search">Search notes</label>
        <input
          id="note-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find text in saved notes"
          disabled={busy || actionOpen}
          aria-describedby="search-results"
        />
        {query && (
          <button
            type="button"
            className="secondary"
            onClick={() => setQuery('')}
            disabled={busy || actionOpen}
          >
            Clear search
          </button>
        )}
        <p id="search-results" className="hint" role="status" aria-live="polite">
          {!isLoading && !error && (
            `${visibleNotes.length} of ${notes.length} notes shown`
          )}
        </p>
      </div>
      {!isLoading && !error && notes.length === 0 && <p>No notes yet.</p>}
      {!isLoading && !error && notes.length > 0 && visibleNotes.length === 0 && (
        <p>No notes match your search. Clear search to see all notes.</p>
      )}
      <ul className="note-list" aria-label="Saved notes">
        {visibleNotes.map((note) => (
          <li key={note.id}>
            <p className="note-text">{note.text}</p>
            <time dateTime={note.created_at}>
              {new Date(note.created_at).toLocaleString()}
            </time>
            {editingId === note.id ? (
              <form className="note-editor" onSubmit={saveEdit}>
                <label htmlFor={`edit-note-${note.id}`}>Edit note</label>
                <textarea
                  id={`edit-note-${note.id}`}
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  rows={4}
                  maxLength={2000}
                  required
                  disabled={busy}
                  aria-describedby={`edit-limit-${note.id}`}
                  autoFocus
                />
                <p id={`edit-limit-${note.id}`} className="hint">
                  {editText.length}/2,000 characters
                </p>
                <div className="note-actions">
                  <button type="submit" disabled={busy || !editText.trim()}>
                    Save changes
                  </button>
                  <button type="button" className="secondary" onClick={cancelAction} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : deletingId === note.id ? (
              <div role="group" aria-label="Confirm note deletion">
                <p>Delete this note permanently? This cannot be undone.</p>
                <div className="note-actions">
                  <button
                    type="button"
                    className="danger"
                    onClick={() => confirmDelete(note.id)}
                    disabled={busy}
                  >
                    Delete permanently
                  </button>
                  <button type="button" className="secondary" onClick={cancelAction} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="note-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || actionOpen}
                  onClick={() => {
                    setEditingId(note.id)
                    setEditText(note.text)
                    setError('')
                    setStatus('')
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={busy || actionOpen}
                  onClick={() => {
                    setDeletingId(note.id)
                    setError('')
                    setStatus('')
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
