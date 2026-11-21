export function readPageSelection() {
  const element = document.activeElement
  if (element instanceof HTMLInputElement && element.type === 'password') {
    return { error: 'Password fields cannot be captured.' }
  }
  if (
    (element instanceof HTMLTextAreaElement ||
      (element instanceof HTMLInputElement &&
        ['text', 'search', 'url', 'tel', 'email'].includes(element.type))) &&
    typeof element.selectionStart === 'number' &&
    typeof element.selectionEnd === 'number'
  ) {
    return { text: element.value.slice(element.selectionStart, element.selectionEnd) }
  }
  return { text: window.getSelection()?.toString() ?? '' }
}

export async function scrapeHighlightedText() {
  const browser = globalThis.chrome
  if (!browser?.scripting?.executeScript || !browser?.tabs?.query) {
    throw new Error('Open the installed Chrome extension to capture selected text.')
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!Number.isInteger(tab?.id) || !/^https?:\/\//.test(tab.url ?? '')) {
    throw new Error('Select text on a normal HTTP or HTTPS webpage, then reopen the popup.')
  }
  let results
  try {
    results = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPageSelection,
    })
  } catch (error) {
    throw new Error(
      'Chrome blocked access to this page. Open the toolbar popup on this tab to grant access, or try a regular webpage outside the Web Store.',
      { cause: error },
    )
  }
  const result = results.find((entry) => entry.frameId === 0)?.result
  if (result?.error) throw new Error(result.error)
  if (typeof result?.text !== 'string' || !result.text.trim()) {
    throw new Error('No highlighted text found in the main page. Select text and try again.')
  }
  if (new TextEncoder().encode(result.text).length > 256 * 1024) {
    throw new Error('Selected text must not exceed 256 KiB.')
  }
  return result.text
}
