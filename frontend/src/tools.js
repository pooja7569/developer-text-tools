import { formatJsonSafe } from './developerTools.js'

const TOOLS_ORIGIN = import.meta.env?.VITE_TOOLS_API_ORIGIN ?? 'http://127.0.0.1:8000'

export function formatJson(text) {
  return formatJsonSafe(text)
}

export async function convertLogToCsv(log) {
  if (!log.trim()) throw new Error('Enter log text before converting.')
  if (new TextEncoder().encode(log).length > 256 * 1024) {
    throw new Error('Log input must not exceed 256 KiB.')
  }
  const response = await fetch(`${TOOLS_ORIGIN}/api/log-to-csv/`, {
    method: 'POST',
    headers: {
      Accept: 'text/csv, application/json',
      'Content-Type': 'application/json',
      'X-Developer-Tools': '1',
    },
    body: JSON.stringify({ log }),
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) {
    const error = response.headers.get('Content-Type')?.includes('application/json')
      ? await response.json() : null
    throw new Error(
      typeof error?.detail === 'string'
        ? error.detail
        : `CSV conversion failed (HTTP ${response.status}).`,
    )
  }
  if (!response.headers.get('Content-Type')?.startsWith('text/csv')) {
    throw new Error('Backend did not return CSV content.')
  }
  const csv = await response.text()
  if (!csv.trim()) throw new Error('Backend returned an empty CSV file.')
  return csv
}
