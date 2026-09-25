import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type SelectOption = { value: string; label: string }

export function SmartSelect({
  value,
  options,
  onChange,
  label,
  disabled = false,
  searchable = false,
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  label: string
  disabled?: boolean
  searchable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [placement, setPlacement] = useState<{
    left: number
    top?: number
    bottom?: number
    width: number
    listMaxHeight: number
  } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const current = options.find(option => option.value === value)
  const visible = query
    ? options.filter(option => option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    : options

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node))
        setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(Math.max(rect.width, 192), window.innerWidth - 16)
      const below = window.innerHeight - rect.bottom
      const chromeHeight = searchable ? 52 : 12
      const desiredHeight = Math.min(280, window.innerHeight * 0.45, Math.max(34, options.length * 42)) + chromeHeight
      const above = below < desiredHeight && rect.top > below
      const available = (above ? rect.top : below) - 12
      const next = {
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        top: above ? undefined : rect.bottom + 4,
        bottom: above ? window.innerHeight - rect.top + 4 : undefined,
        width,
        listMaxHeight: Math.max(32, Math.min(280, window.innerHeight * 0.45, available - chromeHeight)),
      }
      setPlacement(current =>
        current?.left === next.left &&
        current.top === next.top &&
        current.bottom === next.bottom &&
        current.width === next.width &&
        current.listMaxHeight === next.listMaxHeight
          ? current
          : next,
      )
    }
    const onScroll = (event: Event) => {
      if (!popover.current?.contains(event.target as Node)) position()
    }
    position()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', position)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', position)
    }
  }, [open, searchable, options.length])

  const positioned = placement !== null
  useLayoutEffect(() => {
    if (!open || !positioned) return
    if (searchable) search.current?.focus()
    if (query) return
    const selected = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].find(
      option => option.dataset.value === value,
    )
    if (selected && list.current) {
      const selectedRect = selected.getBoundingClientRect()
      const listRect = list.current.getBoundingClientRect()
      list.current.scrollTop += selectedRect.top + selectedRect.height / 2 - (listRect.top + listRect.height / 2)
    }
  }, [open, positioned, value, searchable])

  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
    setQuery('')
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      setOpen(false)
      setQuery('')
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const index = visible.findIndex(option => option.value === value)
      const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (next) choose(next.value)
    }
    if (event.key === 'Enter' && !open) setOpen(true)
  }
  return (
    <div className="smart-select" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={trigger}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? `select-${label}` : undefined}
        value={value}
        disabled={disabled}
        className="smart-select-trigger"
        onClick={() => {
          setQuery('')
          setPlacement(null)
          setOpen(!open)
        }}
      >
        <span>{current?.label ?? '请选择'}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open && placement
        ? createPortal(
            <div
              className="smart-select-popover"
              ref={popover}
              style={{ left: placement.left, top: placement.top, bottom: placement.bottom, width: placement.width }}
            >
              {searchable ? (
                <input
                  ref={search}
                  aria-label={`筛选${label}`}
                  placeholder="输入名称筛选"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                />
              ) : null}
              <div
                className="smart-select-list"
                role="listbox"
                aria-label={label}
                id={`select-${label}`}
                ref={list}
                style={{ maxHeight: placement.listMaxHeight }}
              >
                {visible.map(option => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    data-value={option.value}
                    key={option.value}
                    onClick={() => choose(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
                {!visible.length ? <p>没有匹配项</p> : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
