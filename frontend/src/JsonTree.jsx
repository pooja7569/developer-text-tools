import { useMemo, useState } from 'react'

function JsonNode({ row, childrenByPath }) {
  const [open, setOpen] = useState(false)
  const children = childrenByPath.get(row.path) || []
  const label = <><code>{row.path || '(root)'}</code> <strong>{row.type}</strong> {row.value}</>
  if (!children.length) return <div className="tree-leaf">{label}</div>
  return <details className="tree-node" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open && children.map((child) => <JsonNode key={child.path} row={child} childrenByPath={childrenByPath} />)}
  </details>
}

export default function JsonTree({ rows }) {
  const childrenByPath = useMemo(() => {
    const children = new Map()
    for (const row of rows.slice(1)) {
      const parent = row.path.slice(0, row.path.lastIndexOf('/'))
      if (!children.has(parent)) children.set(parent, [])
      children.get(parent).push(row)
    }
    return children
  }, [rows])
  return rows.length ? <div className="json-tree">
    <JsonNode key={JSON.stringify(rows[0])} row={rows[0]} childrenByPath={childrenByPath} />
  </div> : null
}
