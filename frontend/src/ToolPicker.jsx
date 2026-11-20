import { useEffect, useId, useRef, useState } from 'react'

export default function ToolPicker({ options, value, onChange }) {
  const [open, setOpen] = useState(false)
  const entries = Object.entries(options)
  const selected = entries.findIndex(([key]) => key === value)
  const [active, setActive] = useState(selected)
  const control = useRef(null)
  const trigger = useRef(null)
  const list = useRef(null)
  const search = useRef({ text: '', time: 0 })
  const id = useId()
  const labelId = `${id}-label`
  const valueId = `${id}-value`
  const listId = `${id}-list`

  useEffect(() => {
    if (!open) return
    function dismiss(event) {
      if (!control.current.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open])

  useEffect(() => {
    if (!open) return
    const option = list.current.children[active]
    if (option.offsetTop < list.current.scrollTop) list.current.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > list.current.scrollTop + list.current.clientHeight) {
      list.current.scrollTop = option.offsetTop + option.offsetHeight - list.current.clientHeight
    }
  }, [active, open])

  function choose(index) {
    if (entries[index][0] !== value) onChange(entries[index][0])
    setOpen(false)
    trigger.current.focus()
  }

  function handleKey(event) {
    if (event.key.length !== 1 || event.key === ' ') search.current = { text: '', time: 0 }
    if (event.key === 'Tab') {
      setOpen(false)
      return
    }
    if (event.key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false) }
      return
    }
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault()
      if (open) choose(active)
      else { setActive(selected); setOpen(true) }
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      setActive(event.key === 'Home' ? 0 : event.key === 'End' ? entries.length - 1
        : !open ? selected : (active + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length)
      setOpen(true)
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      const now = Date.now()
      const text = now - search.current.time < 700 ? search.current.text + event.key.toLowerCase() : event.key.toLowerCase()
      search.current = { text, time: now }
      const prefix = [...text].every((letter) => letter === text[0]) ? text[0] : text
      const start = prefix.length === 1 ? (open ? active : selected) + 1 : 0
      const match = entries.findIndex((_, index) => entries[(start + index) % entries.length][1].label.toLowerCase().startsWith(prefix))
      if (match >= 0) { setActive((start + match) % entries.length); setOpen(true) }
    }
  }

  return <div className="tool-picker" ref={control} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }}>
    <label id={labelId} htmlFor={`${id}-trigger`}>Tool</label>
    <div className="tool-control">
      <button id={`${id}-trigger`} ref={trigger} type="button" className="tool-trigger"
        role="combobox" aria-labelledby={`${labelId} ${valueId}`} aria-expanded={open}
        aria-haspopup="listbox" aria-controls={listId}
        aria-activedescendant={open ? `${id}-option-${active}` : undefined}
        onKeyDown={handleKey} onClick={() => { setActive(selected); setOpen(!open) }}>
        <span id={valueId}>{options[value].label}</span>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      <ul id={listId} className="tool-options" ref={list} role="listbox"
        aria-labelledby={labelId} hidden={!open}>
        {entries.map(([key, option], index) =>
          <li id={`${id}-option-${index}`} key={key} role="option"
            aria-selected={key === value} className={index === active ? 'active-option' : ''}
            onPointerMove={() => setActive(index)} onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(index)}>
            <span>{option.label}</span>
            {key === value && <span className="option-selected" aria-hidden="true">Selected</span>}
          </li>)}
      </ul>
    </div>
  </div>
}
