import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterNotes } from './filterNotes.js'

const notes = Object.freeze([
  Object.freeze({ id: 3, text: 'Shopping list: apples and tea' }),
  Object.freeze({ id: 2, text: 'Meeting\nnotes for tomorrow' }),
  Object.freeze({ id: 1, text: 'Tea break: [10:00].*' }),
])

test('empty or whitespace-only searches show every note in its original order', () => {
  for (const query of ['', ' ', '\n\t']) {
    assert.deepEqual(filterNotes(notes, query), notes)
  }
})

test('matches case-insensitively and ignores surrounding search whitespace', () => {
  assert.deepEqual(filterNotes(notes, '  TEA  '), [notes[0], notes[2]])
})

test('matches substrings and multiline text', () => {
  assert.deepEqual(filterNotes(notes, 'pples'), [notes[0]])
  assert.deepEqual(filterNotes(notes, 'meeting\nnotes'), [notes[1]])
})

test('treats punctuation as literal text, not a regular expression', () => {
  assert.deepEqual(filterNotes(notes, '[10:00].*'), [notes[2]])
  assert.deepEqual(filterNotes(notes, '.*'), [notes[2]])
})

test('returns no matches for absent text or an empty list', () => {
  assert.deepEqual(filterNotes(notes, 'not found'), [])
  assert.deepEqual(filterNotes([], 'tea'), [])
})

test('does not alter notes or their order when searching and clearing', () => {
  filterNotes(notes, 'tea')
  assert.deepEqual(filterNotes(notes, ''), notes)
  assert.deepEqual(notes.map((note) => note.id), [3, 2, 1])
})

test('search reflects edited, added, and deleted notes without a separate cache', () => {
  const edited = notes.map((note) =>
    note.id === 1 ? { ...note, text: 'Coffee break' } : note,
  )
  assert.deepEqual(filterNotes(edited, 'tea'), [notes[0]])
  const added = [{ id: 4, text: 'New tea note' }, ...edited]
  assert.deepEqual(filterNotes(added, 'tea').map((note) => note.id), [4, 3])
  const deleted = added.filter((note) => note.id !== 3)
  assert.deepEqual(filterNotes(deleted, 'tea').map((note) => note.id), [4])
})
