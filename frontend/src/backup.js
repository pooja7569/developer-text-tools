import { fetchNotes } from './api.js'
import { downloadText } from './download.js'

export async function readNotesBackup(file) {
  if (file.size > 1024 * 1024) {
    throw new Error('Backup must be at most 1 MB (1,048,576 bytes).')
  }
  const text = await file.text()
  let backup
  try {
    backup = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new Error('This file is not valid JSON.')
  }
  if (
    typeof backup !== 'object' || backup === null ||
    backup.version !== 1 ||
    typeof backup.exported_at !== 'string' ||
    !Number.isFinite(Date.parse(backup.exported_at)) ||
    !Array.isArray(backup.notes)
  ) {
    throw new Error('Choose a version 1 notes backup with exported_at and notes fields.')
  }
  if (backup.notes.length > 500) {
    throw new Error('A backup can contain at most 500 notes per import.')
  }
  for (const [index, note] of backup.notes.entries()) {
    if (
      typeof note !== 'object' || note === null ||
      !Number.isSafeInteger(note.id) || note.id < 1 ||
      typeof note.text !== 'string' || !note.text.trim() ||
      [...note.text.trim()].length > 2000 ||
      typeof note.created_at !== 'string' ||
      !Number.isFinite(Date.parse(note.created_at))
    ) {
      throw new Error(`Note ${index + 1} is invalid. Each note needs a positive id, 1-2,000 characters of text, and created_at.`)
    }
  }
  return backup
}

export async function exportNotesBackup() {
  const notes = await fetchNotes()
  const backup = {
    version: 1,
    exported_at: new Date().toISOString(),
    notes,
  }
  downloadText(
    `${JSON.stringify(backup, null, 2)}\n`,
    `local-notes-${backup.exported_at.replace(/[:.]/g, '-')}.json`,
    'application/json;charset=utf-8',
  )
  return notes.length
}
