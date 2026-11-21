export function isPopupView(view) {
  const extension = globalThis.chrome?.extension
  return Boolean(view && extension?.getViews && extension.getViews({ type: 'popup' }).includes(view))
}

export async function openSidePanel() {
  const browser = globalThis.chrome
  if (!browser?.sidePanel?.open || !browser?.tabs?.query) {
    throw new Error('Side panel requires Chrome 116 or newer and the loaded extension.')
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  if (!Number.isInteger(tab?.windowId)) throw new Error('No active Chrome window.')
  await browser.sidePanel.open({ windowId: tab.windowId })
}

export async function openFullPage() {
  const browser = globalThis.chrome
  if (!browser?.runtime?.getURL || !browser?.tabs?.create) {
    throw new Error('Open the installed Chrome extension to use full-page view.')
  }
  await browser.tabs.create({ url: browser.runtime.getURL('index.html'), active: true })
}
