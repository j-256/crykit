import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

const POPUP_WIDTH = 320
const VIEWPORT_GAP = 16
const POPUP_OFFSET = 8
const HOVER_CLOSE_DELAY = 180

export function AdminHelp({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLSpanElement>(null)
  const wrapper = useRef<HTMLSpanElement>(null)
  const closeTimer = useRef<number | null>(null)
  const id = useId()
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current) }, [])
  const cancelClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const bounds = trigger.current?.getBoundingClientRect()
      if (!bounds) return
      const width = Math.min(POPUP_WIDTH, window.innerWidth - VIEWPORT_GAP * 2)
      const height = popup.current?.offsetHeight ?? 0
      setPosition({
        left: Math.max(VIEWPORT_GAP, Math.min(bounds.left, window.innerWidth - width - VIEWPORT_GAP)),
        top: bounds.bottom + height + VIEWPORT_GAP > window.innerHeight
          ? Math.max(VIEWPORT_GAP, bounds.top - height - POPUP_OFFSET)
          : bounds.bottom + POPUP_OFFSET,
      })
    }
    const dismiss = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
    }
  }, [open])
  return <span ref={wrapper} className="admin-help" onMouseEnter={() => { cancelClose(); setOpen(true) }} onMouseLeave={() => { if (!wrapper.current?.contains(document.activeElement)) closeTimer.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY) }} onFocus={() => { cancelClose(); setOpen(true) }} onBlur={(event) => { if (!wrapper.current?.contains(event.relatedTarget as Node)) setOpen(false) }}>
    <button ref={trigger} type="button" className="admin-help-trigger" aria-expanded={open} aria-describedby={open ? id : undefined} onClick={() => setOpen(true)}><span className="admin-help-trigger-text">{label}</span></button>
    {open && <span ref={popup} id={id} role="tooltip" className="admin-help-popup" style={position} onMouseEnter={cancelClose}>{text}</span>}
  </span>
}

const good = new Set(['running', 'active', 'complete', 'completed', 'verified'])
const warning = new Set(['paused', 'pending', 'queued', 'waiting', 'read-only', 'uncertain', 'invited', 'accepted'])
const danger = new Set(['failed', 'blocked', 'deleting', 'revoked', 'cancelled', 'removed', 'rejected'])

export function statusTone(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized.includes('accepted') || normalized.includes('uncertain') || normalized.includes('waiting')) return 'warning'
  return good.has(normalized) ? 'good' : warning.has(normalized) ? 'warning' : danger.has(normalized) ? 'danger' : ''
}

export function StatusBadge({ value, helpText }: { value: string; helpText?: string }) {
  const tone = statusTone(value)
  return <span className={`admin-status${tone ? ` admin-status--${tone}` : ''}${helpText ? ' admin-status--help' : ''}`}>{helpText ? <AdminHelp label={value} text={helpText} /> : value}</span>
}
