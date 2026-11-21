import { useEffect, useState } from 'react'
import { convertLogToCsv, formatJson } from './tools.js'
import { scrapeHighlightedText } from './selection.js'
import { downloadText } from './download.js'
import {
  changeReport, compareBatch, compareJson, decodeJwt, inspectValue, jsonToYaml,
  parseJson, redactJson, yamlToJson,
} from './developerTools.js'
import { generateModels } from './codegen.js'
import JsonTree from './JsonTree.jsx'
import AccountPanel from './AccountPanel.jsx'
import ToolPicker from './ToolPicker.jsx'
import { accountsEnabled, accountRequest } from './account.js'
import {
  emptyStore, parseWorkspaceBackup, proPreview, readJsonFiles, STORAGE_KEY, STORAGE_LIMIT, workspaceRequest,
} from './workspaces.js'

const cloudBuild = import.meta.env?.VITE_CLOUD_BUILD === 'true'
const DEFAULT_REDACTION = 'password, token, authorization, api_key, secret'
const SAMPLE = '{\n  "id": 42,\n  "name": "Example",\n  "status": "active",\n  "meta": { "requestId": "demo-1" }\n}'
const TOOLS = {
  json: { label: 'JSON formatter', action: 'Format JSON', input: 'JSON input' },
  'json-yaml': { label: 'JSON to YAML', action: 'Convert to YAML', input: 'JSON input' },
  'yaml-json': { label: 'YAML to JSON', action: 'Convert to JSON', input: 'YAML input' },
  jwt: { label: 'JWT decoder', action: 'Decode JWT', input: 'JWT input' },
  csv: { label: 'Log to CSV', action: 'Download CSV', input: 'Log input' },
}

export default function Workspace() {
  const [tab, setTab] = useState('Tools')
  const [tool, setTool] = useState('json')
  const [input, setInput] = useState('')
  const [baseline, setBaseline] = useState('')
  const [output, setOutput] = useState('')
  const [extension, setExtension] = useState('txt')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState([])
  const [search, setSearch] = useState('')
  const [changes, setChanges] = useState(null)
  const [ignores, setIgnores] = useState('')
  const [redaction, setRedaction] = useState(DEFAULT_REDACTION)
  const [root, setRoot] = useState('ApiResponse')
  const [extra, setExtra] = useState('ignore')
  const [store, setStore] = useState(emptyStore)
  const [selected, setSelected] = useState('')
  const [name, setName] = useState('My API')
  const [backup, setBackup] = useState(null)
  const [storageReady, setStorageReady] = useState(false)
  const [account, setAccount] = useState({ signedIn: false, pro: false })
  const canPro = proPreview || account.pro

  useEffect(() => {
    let active = true
    workspaceRequest({ action: 'read' }).then((result) => {
      if (active) { setStore(result); setStorageReady(true) }
    }).catch((failure) => {
      console.error('Workspace read failed:', failure.name)
      if (active) setError(failure.message)
    })
    return () => { active = false }
  }, [])

  async function run(action) {
    setBusy(true)
    setError('')
    setStatus('')
    try {
      await action()
    } catch (failure) {
      console.error('Developer tool failed:', failure.name)
      setError(failure.name === 'TimeoutError'
        ? 'Request timed out. Check the backend and try again.'
        : failure.message || 'Unexpected tool failure.')
    } finally {
      setBusy(false)
    }
  }

  async function requirePro() {
    if (proPreview) return
    try {
      const latest = await accountRequest('authorize')
      setAccount(latest)
      if (!latest.pro) throw new Error('Pro access is not active. Complete test checkout and refresh account/access.')
    } catch (failure) {
      setAccount((previous) => ({ ...previous, pro: false }))
      throw failure
    }
  }

  function result(text, suffix = 'json') {
    setOutput(text)
    setExtension(suffix)
    setStatus('Processed locally. Review the output before copying or downloading.')
  }

  function updateInput(text) {
    setInput(text)
    setRows([])
    setChanges(null)
    setOutput('')
    setStatus('')
  }

  async function refresh() {
    const next = await workspaceRequest({ action: 'read' })
    setStore(next)
    setStorageReady(true)
    setStatus('Workspaces refreshed. Unsaved input kept.')
  }

  async function save() {
    const next = await workspaceRequest({
      action: 'save', revision: store.revision,
      workspace: {
        id: selected || crypto.randomUUID(), name, baseline, current: input,
        ignores: canPro ? ignores : '', redaction: canPro ? redaction : '',
        root: canPro ? root : 'ApiResponse', extra: canPro ? extra : 'ignore',
        updatedAt: new Date().toISOString(),
      },
    })
    setStore(next)
    setSelected(next.workspaces.at(-1).id)
    setStatus('JSON workspace saved on this device. Tokens and outputs are not auto-saved.')
  }

  function load(workspace) {
    updateInput(workspace.current)
    setBaseline(workspace.baseline)
    setSelected(workspace.id)
    setName(workspace.name)
    setIgnores(workspace.ignores)
    setRedaction(workspace.redaction || DEFAULT_REDACTION)
    setRoot(workspace.root)
    setExtra(workspace.extra)
    setStatus('Workspace loaded. Advanced presets run only with Pro access or the development preview.')
  }

  async function exportBackup() {
    if (!globalThis.chrome?.runtime) throw new Error('Load the compiled extension in Chrome first.')
    const response = await chrome.runtime.sendMessage({ channel: STORAGE_KEY, action: 'export' })
    if (!response?.ok || typeof response.backup !== 'string') throw new Error(response?.error || 'Backup export failed.')
    downloadText(response.backup, 'devtoolbox-workspaces.json', 'application/json')
    setStatus('Backup download requested. It contains unencrypted saved inputs; keep it private.')
  }

  async function runSelectedTool() {
    if (tool === 'json') {
      const formatted = formatJson(input)
      updateInput(formatted)
      result(formatted)
    } else if (tool === 'json-yaml') result(jsonToYaml(input), 'yaml')
    else if (tool === 'yaml-json') result(yamlToJson(input))
    else if (tool === 'jwt') result(decodeJwt(input))
    else {
      const csv = await convertLogToCsv(input)
      downloadText('\uFEFF' + csv, 'logs.csv', 'text/csv;charset=utf-8')
      setStatus('CSV download requested. Check Chrome Downloads.')
    }
  }

  const filteredRows = rows.filter((row) =>
    `${row.path} ${row.type} ${row.value}`.toLowerCase().includes(search.toLowerCase()))
  const inputLabel = tab === 'Tools' ? TOOLS[tool].input : tab === 'Compare' ? 'Current JSON' : 'JSON input'
  const remoteTool = tab === 'Tools' && tool === 'csv'
  const splitOutput = tab === 'Tools' || tab === 'Generate'

  const outputPanel = <section className="output-pane" aria-label="Tool output">
    <div className="editor-heading">
      <label htmlFor="tool-output">Output (review before sharing)</label>
      {output && <span className="badge">.{extension}</span>}
    </div>
    <textarea id="tool-output" rows={12} value={output} readOnly spellCheck={false}
      placeholder={remoteTool ? 'CSV is downloaded after conversion; check Chrome Downloads.' : 'Run a tool to see its output here.'} />
    {output && <div className="actions compact-actions editor-controls" role="group" aria-label="Output actions">
      <button type="button" className="secondary" onClick={() => run(async () => {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable. Select the output and copy manually.')
        await navigator.clipboard.writeText(output); setStatus('Output copied.')
      })}>Copy output</button>
      <button type="button" className="secondary" onClick={() => {
        downloadText(output, `devtoolbox-output.${extension}`, 'text/plain;charset=utf-8')
        setStatus('Output download requested. Check Chrome Downloads.')
      }}>Download output</button>
      <button type="button" className="quiet" onClick={() => setOutput('')}>Clear output</button>
    </div>}
  </section>

  return (
    <section aria-label="JSON and log tools" aria-busy={busy}>
      <p className="hint plan-summary">
        {proPreview ? 'Development Pro preview - not a paid account. Do not publish this build.'
          : accountsEnabled ? 'Free: local tools + one saved workspace. Optional Google sign-in and Stripe TEST subscriptions; real billing disabled.'
            : 'Free: local tools + one saved workspace. Planned Pro: $1/month; billing and sign-in are not available.'}
      </p>
      {accountsEnabled && <AccountPanel account={account} onChange={setAccount} />}
      <fieldset disabled={busy}>
        <nav className="tabs" aria-label="Developer tools">
          {['Tools', 'Compare', 'Generate', 'Workspaces'].map((item) =>
            <button key={item} type="button" className={tab === item ? 'selected' : 'secondary'}
              aria-pressed={tab === item} onClick={() => { setTab(item); setError('') }}>{item}</button>)}
        </nav>
        {tab === 'Tools' && <ToolPicker options={TOOLS} value={tool} onChange={(value) => {
          setTool(value); setOutput(''); setRows([]); setError(''); setStatus('')
        }} />}
        <div className={`editor-grid${splitOutput || tab === 'Compare' ? ' two-editors' : ''}`}>
        <section className="input-pane" aria-label="Tool input">
        <div className="editor-heading">
          <label htmlFor="tool-input">{inputLabel}</label>
          <span className={remoteTool ? 'badge remote-badge' : 'badge'}>{remoteTool ? 'Sends to server' : 'Local processing'}</span>
        </div>
        <textarea id="tool-input" rows={12} value={input}
          onChange={(event) => updateInput(event.target.value)} aria-describedby="tool-privacy" spellCheck={false}
          placeholder={tab === 'Tools' && tool === 'jwt' ? 'Paste a JWT to decode locally. Signatures are not verified.' : `Paste ${inputLabel.toLowerCase()} here.`} />
        <p id="tool-privacy" className="hint">
          {remoteTool
            ? `CSV conversion sends your input to ${cloudBuild ? 'the configured HTTPS server' : 'local Django'}. Do not send secrets or sensitive logs.`
            : 'Processed on this device. Tool input is not uploaded.'}
        </p>
        <div className="editor-controls" role="group" aria-label="Input actions">
        {tab === 'Tools' && <div className="actions tool-actions">
          <button type="button" onClick={() => run(runSelectedTool)}>{TOOLS[tool].action}</button>
          {tool === 'json' && <button type="button" className="secondary" onClick={() => run(() => {
            setRows(inspectValue(parseJson(input)))
            setStatus('Valid JSON. Object paths use JSON pointer escaping; duplicate keys are rejected.')
          })}>Validate / inspect</button>}
        </div>}
        <div className="actions compact-actions draft-actions" role="group" aria-label="Draft actions">
          <button type="button" className="quiet" onClick={() => run(async () => {
            updateInput(await scrapeHighlightedText())
            setStatus('Highlighted text copied. Nothing uploaded.')
          })}>Capture selection</button>
          <button type="button" className="quiet" onClick={() => {
            if (tab === 'Tools') setTool('json')
            updateInput(SAMPLE)
            setBaseline(SAMPLE.replace('"active"', '"paused"').replace('demo-1', 'demo-2'))
            setStatus('Sample loaded. Open Compare to see the two differences.')
          }}>Try sample</button>
          <button type="button" className="quiet" onClick={() => {
            updateInput(''); setBaseline(''); setRows([]); setSelected('')
            setStatus('Drafts cleared. Saved workspaces were not deleted.')
          }}>Clear drafts</button>
        </div>
        </div>
        <p className="hint draft-hint">Drafts are temporary. Save a workspace to keep your JSON.</p>
        </section>
        {tab === 'Compare' && <section className="baseline-pane" aria-label="Comparison baseline">
          <div className="editor-heading"><label htmlFor="baseline">Baseline JSON</label></div>
          <textarea id="baseline" rows={12} value={baseline} spellCheck={false}
            placeholder="Paste the JSON response you want to compare against."
            onChange={(event) => { setBaseline(event.target.value); setChanges(null); setOutput('') }} />
          <div className="actions compact-actions">
            <button type="button" className="secondary" onClick={() => run(() => {
              parseJson(input); setBaseline(input); setChanges(null); setOutput('')
              setStatus('Baseline set from current JSON. Save explicitly to keep it.')
            })}>Use current as baseline</button>
          </div>
        </section>}
        {splitOutput && outputPanel}
        </div>

        {tab === 'Tools' && <>
          {rows.length > 0 && <>
            <label htmlFor="json-search">Search JSON paths and values</label>
            <input id="json-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
            {!search && <><p className="hint">Expand objects and arrays to inspect the JSON tree.</p><JsonTree rows={rows} /></>}
            {search && <><p className="hint">Showing {Math.min(filteredRows.length, 200)} of {filteredRows.length} matches.</p>
            <ul className="inspection">{filteredRows.slice(0, 200).map((row) =>
              <li key={row.path}><code>{row.path || '(root)'}</code> <strong>{row.type}</strong>
                <span>{row.value}</span></li>)}</ul></>}
          </>}
        </>}

        {tab === 'Compare' && <>
          <label htmlFor="ignores">Ignore exact paths (Pro, one JSON pointer per line)</label>
          <textarea id="ignores" rows={3} value={ignores} disabled={!canPro}
            placeholder="/meta/requestId" onChange={(event) => {
              setIgnores(event.target.value); setChanges(null); setOutput('')
            }} />
          <button type="button" onClick={() => run(async () => {
            if (canPro) await requirePro()
            const diff = compareJson(baseline, input, canPro ? ignores : '')
            setChanges(diff)
            setOutput('')
            if (canPro) result(changeReport(diff))
            setStatus(`${diff.length} changes. Object order ignored; array order matters.`)
          })}>Compare JSON</button>
          <p className="hint">Removed fields and type changes may break consumers; this is not contract verification.
            Free comparisons do not apply saved ignore rules.</p>
          {changes !== null && <ul className="inspection">{changes.slice(0, 200).map((change) =>
            <li key={change.path} className={change.potentialBreaking ? 'error' : ''}>
              <code>{change.path || '(root)'}</code> <strong>{change.type}</strong>
              <span>Before: {change.before}</span><span>After: {change.after}</span>
            </li>)}</ul>}
          {changes?.length > 200 && <p className="hint">First 200 changes shown; the Pro report includes all changes.</p>}
          <label htmlFor="batch">Batch compare against baseline (Pro, 1-20 JSON files)</label>
          <input id="batch" type="file" accept=".json,application/json" multiple disabled={!canPro}
            onChange={(event) => {
              const files = [...event.target.files]
              event.target.value = ''
              run(async () => {
                await requirePro()
                result(JSON.stringify(compareBatch(baseline, await readJsonFiles(files), ignores), null, 2))
              })
            }} />
        </>}

        {tab === 'Generate' && <>
          <p className="hint">Pro: separate multiple JSON examples with a line containing ---.
            Fields missing in some examples become optional. Generated types need review.</p>
          <label htmlFor="root-type">Root type name</label>
          <input id="root-type" value={root} disabled={!canPro} onChange={(event) => setRoot(event.target.value)} />
          <label htmlFor="extra">Pydantic v2 extra fields</label>
          <select id="extra" value={extra} disabled={!canPro} onChange={(event) => setExtra(event.target.value)}>
            <option value="ignore">Ignore unknown fields</option>
            <option value="forbid">Reject unknown fields</option>
          </select>
          <div className="actions">{['typescript', 'pydantic'].map((language) =>
            <button key={language} type="button" disabled={!canPro} onClick={() => run(async () => {
              await requirePro()
              const generated = generateModels(input, { language, root, extra })
              result(generated.code, language === 'typescript' ? 'ts' : 'py')
              setStatus(generated.warnings.join(' '))
            })}>{language === 'typescript' ? 'JSON to TypeScript' : 'JSON to Pydantic v2'}</button>)}</div>
          <label htmlFor="redaction">Redact matching field names (Pro, comma-separated)</label>
          <input id="redaction" value={redaction} disabled={!canPro}
            onChange={(event) => setRedaction(event.target.value)} />
          <button type="button" className="secondary" disabled={!canPro}
            onClick={() => run(async () => {
              await requirePro()
              result(redactJson(input, redaction))
              setStatus('Redaction preview only. Unmatched secrets may remain; original input and saved workspaces are unchanged.')
            })}>Preview redaction</button>
        </>}

        {tab === 'Workspaces' && <>
          <p className="hint">Saves baseline and current JSON, not JWT tokens or generated output.
            Loading replaces drafts. Storage is local, unencrypted, and not synced.</p>
          <label htmlFor="workspace-name">Workspace name</label>
          <input id="workspace-name" maxLength={80} value={name} onChange={(event) => setName(event.target.value)} />
          <div className="actions">
            <button type="button" disabled={!storageReady} onClick={() => run(save)}>
              {selected ? 'Update workspace' : 'Save workspace'}</button>
            <button type="button" className="secondary" onClick={() => {
              setSelected(''); setName('My API'); setIgnores(''); setRedaction(DEFAULT_REDACTION)
              setRoot('ApiResponse'); setExtra('ignore')
              setStatus('New workspace draft. Enter current and baseline JSON before saving.')
            }}>New workspace</button>
            <button type="button" className="secondary" onClick={() => run(refresh)}>Refresh workspaces</button>
            <button type="button" className="secondary" onClick={() => run(exportBackup)}>Export workspace backup</button>
          </div>
          <p>{store.workspaces.length} saved workspace(s). {canPro ? 'Pro/preview limit: 50.' : 'Free limit: 1.'}</p>
          <ul className="workspace-list">{store.workspaces.map((workspace) =>
            <li key={workspace.id}><strong>{workspace.name}</strong>
              <time dateTime={workspace.updatedAt}>{new Date(workspace.updatedAt).toLocaleString()}</time>
              <div className="actions">
                <button type="button" className="secondary" onClick={() => load(workspace)}>Load</button>
                <button type="button" className="secondary" onClick={() => {
                  downloadText(JSON.stringify({ version: 1, revision: 0, workspaces: [workspace] }, null, 2),
                    'devtoolbox-workspace.json', 'application/json')
                  setStatus('Workspace download requested.')
                }}>Export</button>
                <button type="button" className="danger" onClick={() => {
                  if (window.confirm(`Permanently delete "${workspace.name}"? Export a backup first.`)) {
                    run(async () => {
                      setStore(await workspaceRequest({ action: 'delete', revision: store.revision, id: workspace.id }))
                      if (selected === workspace.id) setSelected('')
                      setStatus('Workspace deleted. Drafts kept.')
                    })
                  }
                }}>Delete</button>
              </div>
            </li>)}</ul>
          <label htmlFor="workspace-backup">Import workspace backup (additive, 4 MiB maximum)</label>
          <input id="workspace-backup" type="file" accept=".json,application/json" onChange={(event) => {
            const file = event.target.files[0]
            event.target.value = ''
            setBackup(null)
            if (file) run(async () => {
              if (file.size > STORAGE_LIMIT) throw new Error('Workspace backup must not exceed 4 MiB.')
              setBackup(parseWorkspaceBackup(await file.text()))
              setStatus('Backup validated. Confirm import to add new workspace IDs; existing IDs are skipped.')
            })
          }} />
          {backup && <div className="actions">
            <button type="button" disabled={!storageReady} onClick={() => run(async () => {
              setStore(await workspaceRequest({ action: 'import', revision: store.revision, store: backup }))
              setBackup(null); setStatus('Backup imported. Existing workspaces kept.')
            })}>Confirm import ({backup.workspaces.length})</button>
            <button type="button" className="secondary" onClick={() => setBackup(null)}>Cancel import</button>
          </div>}
        </>}

        {!splitOutput && output && outputPanel}
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <p role="status" aria-live="polite">{status}</p>
    </section>
  )
}
