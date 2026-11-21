function isView(view, type) {
  const extension = globalThis.chrome?.extension
  return Boolean(view && extension?.getViews && extension.getViews({ type }).includes(view))
}

export function isPopupView(view) {
  return isView(view, 'popup')
}

export function isFullPageView(view) {
  return isView(view, 'tab') && !isSidePanelView(view)
}

export function isSidePanelView(view) {
  const entry = globalThis.chrome?.runtime?.getURL?.('index.html')
  return Boolean(entry && view?.location?.href?.split(/[?#]/)[0] === entry
    && new URL(view.location.href).searchParams.get('view') === 'side-panel')
}
