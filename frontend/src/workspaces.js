import { checkInput, parseJson, parseIgnoreRules } from './developerTools.js'

export const STORAGE_KEY = 'devtoolbox.workspaces.v1'
export const STORAGE_LIMIT = 4 * 1024 * 1024
export const emptyStore = () => ({ version: 1, revision: 0, workspaces: [] })
const preview = import.meta.env?.VITE_PRO_PREVIEW === 'true'
export const proPreview = preview

function validateWorkspace(workspace) {
  if (!workspace || typeof workspace !== 'object' ||
    typeof workspace.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(workspace.id) ||
    typeof workspace.name !== 'string' || !workspace.name.trim() || workspace.name.length > 80 ||
    typeof workspace.baseline !== 'string' || typeof workspace.current !== 'string' ||
    typeof workspace.ignores !== 'string' || typeof workspace.redaction !== 'string' ||
    workspace.redaction.length > 2000 || typeof workspace.root !== 'string' ||
    !/^[A-Z][A-Za-z0-9]{0,49}$/.test(workspace.root) ||
    !['ignore', 'forbid'].includes(workspace.extra) ||
    typeof workspace.updatedAt !== 'string' || !Number.isFinite(Date.parse(workspace.updatedAt))) {
    throw new Error('Invalid workspace data. Existing data was not changed.')
  }
  parseJson(workspace.baseline)
  parseJson(workspace.current)
  parseIgnoreRules(workspace.ignores)
  return {
    id: workspace.id, name: workspace.name.trim(), baseline: workspace.baseline,
    current: workspace.current, ignores: workspace.ignores, redaction: workspace.redaction,
    root: workspace.root, extra: workspace.extra, updatedAt: workspace.updatedAt,
  }
}

export function validateStore(store) {
  if (!store || store.version !== 1 || !Number.isSafeInteger(store.revision) || store.revision < 0 ||
    !Array.isArray(store.workspaces) || store.workspaces.length > 50) {
    throw new Error('Unsupported or corrupt workspace storage. Export or fix the backup; data was not reset.')
  }
  const workspaces = store.workspaces.map(validateWorkspace)
  if (new Set(workspaces.map((item) => item.id)).size !== workspaces.length) {
    throw new Error('Workspace IDs must be unique.')
  }
  const result = { version: 1, revision: store.revision, workspaces }
  if (new TextEncoder().encode(JSON.stringify(result)).length > STORAGE_LIMIT) {
    throw new Error('Workspace storage must not exceed 4 MiB.')
  }
  return result
}

export function mutateStore(store, request, allowPro = false) {
  const current = validateStore(store)
  if (request.revision !== current.revision) {
    throw new Error('Workspaces changed in another window. Refresh before saving; your draft is still here.')
  }
  let workspaces = current.workspaces
  if (request.action === 'save') {
    let saved = validateWorkspace(request.workspace)
    const existing = workspaces.find((item) => item.id === saved.id)
    if (!existing && workspaces.length >= (allowPro ? 50 : 1)) {
      throw new Error(allowPro ? 'Maximum 50 workspaces.' : 'Free includes one saved workspace. Export or delete it before adding another.')
    }
    if (!allowPro && (saved.ignores || saved.redaction || saved.root !== 'ApiResponse' || saved.extra !== 'ignore')) {
      throw new Error('Advanced saved presets require Pro access (or the development Pro preview).')
    }
    if (!allowPro && existing) {
      saved = {
        ...saved, ignores: existing.ignores, redaction: existing.redaction,
        root: existing.root, extra: existing.extra,
      }
    }
    workspaces = [...workspaces.filter((item) => item.id !== saved.id), saved]
  } else if (request.action === 'delete') {
    if (!workspaces.some((item) => item.id === request.id)) throw new Error('Workspace no longer exists. Refresh.')
    workspaces = workspaces.filter((item) => item.id !== request.id)
  } else if (request.action === 'import') {
    const imported = validateStore(request.store)
    const additions = imported.workspaces.filter((item) => !workspaces.some((saved) => saved.id === item.id))
    if (workspaces.length + additions.length > (allowPro ? 50 : 1)) {
      throw new Error('Import exceeds the saved-workspace limit. No workspaces were imported.')
    }
    if (!allowPro && additions.some((item) => item.ignores || item.redaction || item.root !== 'ApiResponse' || item.extra !== 'ignore')) {
      throw new Error('This backup includes advanced presets. Pro access is required to import it.')
    }
    workspaces = [...workspaces, ...additions]
  } else throw new Error('Unsupported workspace operation.')
  return validateStore({ version: 1, revision: current.revision + 1, workspaces })
}

export function parseWorkspaceBackup(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > STORAGE_LIMIT) {
    throw new Error('Workspace backup must not exceed 4 MiB.')
  }
  return validateStore(JSON.parse(text))
}

export async function workspaceRequest(request) {
  if (!globalThis.chrome?.runtime?.sendMessage) throw new Error('Load the compiled extension in Chrome to use saved workspaces.')
  const response = await chrome.runtime.sendMessage({ channel: STORAGE_KEY, ...request })
  if (!response?.ok) throw new Error(response?.error || 'Workspace service did not respond.')
  return validateStore(response.store)
}

export async function readJsonFiles(fileList) {
  const files = [...fileList]
  if (!files.length || files.length > 20) throw new Error('Choose 1-20 JSON files.')
  if (files.some((file) => file.size > 256 * 1024) || files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) {
    throw new Error('Files must be at most 256 KiB each and 2 MiB in total.')
  }
  return Promise.all(files.map(async (file) => {
    const text = await file.text()
    checkInput(text)
    return { name: file.name, text }
  }))
}
