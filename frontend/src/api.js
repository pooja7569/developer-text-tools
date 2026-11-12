const API_URL = 'http://127.0.0.1:8000/api'

async function request(path, options = {}) {
  const response = await fetch(`${API_URL}/${path}/`, {
    method: 'GET',
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
    ...options,
    headers: { Accept: 'application/json', ...options.headers },
  })

  if (!response.ok) {
    if (path === 'notes/import') {
      const error = await response.json()
      throw new Error(
        typeof error?.detail === 'string'
          ? error.detail
          : `Backup rejected (HTTP ${response.status}). Check the backup format and limits.`,
      )
    }
    if (response.status === 400 && path.startsWith('notes')) {
      const error = await response.json()
      if (error !== null && Array.isArray(error.text) && error.text.every(
        (message) => typeof message === 'string',
      )) {
        throw new Error(error.text.join(' '))
      }
    }
    if (response.status === 404 && path.startsWith('notes/')) {
      throw new Error('This note no longer exists. Cancel and refresh notes.')
    }
    throw new Error(`Backend returned HTTP ${response.status}.`)
  }

  return response.status === 204 ? null : response.json()
}

export async function fetchGreeting() {
  const data = await request('greet')
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof data.message !== 'string'
  ) {
    throw new Error('Backend response must contain a message string.')
  }

  return data.message
}

function isNote(note) {
  return (
    typeof note === 'object' &&
    note !== null &&
    Number.isSafeInteger(note.id) &&
    note.id > 0 &&
    typeof note.text === 'string' &&
    typeof note.created_at === 'string' &&
    Number.isFinite(Date.parse(note.created_at))
  )
}

export async function fetchNotes() {
  const data = await request('notes', {
    headers: { 'X-Local-Notes': '1' },
  })
  if (!Array.isArray(data) || !data.every(isNote)) {
    throw new Error('Backend returned an invalid notes list.')
  }
  return data
}

async function writeNote(path, method, text) {
  const data = await request(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Local-Notes': '1' },
    body: JSON.stringify({ text }),
  })
  if (!isNote(data)) {
    throw new Error('Backend returned an invalid saved note.')
  }
  return data
}

export function createNote(text) {
  return writeNote('notes', 'POST', text)
}

export function updateNote(id, text) {
  return writeNote(`notes/${id}`, 'PATCH', text)
}

export async function deleteNote(id) {
  await request(`notes/${id}`, {
    method: 'DELETE',
    headers: { 'X-Local-Notes': '1' },
  })
}

export async function importNotesBackup(backup) {
  const data = await request('notes/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Local-Notes': '1' },
    body: JSON.stringify(backup),
  })
  if (
    typeof data !== 'object' ||
    data === null ||
    !Number.isSafeInteger(data.imported) ||
    data.imported < 0 ||
    !Number.isSafeInteger(data.skipped) ||
    data.skipped < 0 ||
    data.imported + data.skipped !== backup.notes.length ||
    !Array.isArray(data.notes) ||
    !data.notes.every(isNote)
  ) {
    throw new Error('Backend returned an invalid import result. Refresh notes before retrying.')
  }
  return data
}
