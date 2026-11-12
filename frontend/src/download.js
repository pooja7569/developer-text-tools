export function downloadText(text, filename, contentType) {
  const blob = new Blob([text], { type: contentType })
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  try {
    link.href = url
    link.download = filename
    link.hidden = true
    document.body.append(link)
    link.click()
  } finally {
    link.remove()
    // Let Chrome process the download before releasing the Blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
