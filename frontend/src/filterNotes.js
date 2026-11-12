export function filterNotes(notes, query) {
  const search = query.trim().toLowerCase()
  return search
    ? notes.filter((note) => note.text.toLowerCase().includes(search))
    : notes
}
