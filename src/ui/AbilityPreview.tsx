import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

const PREVIEW_WIDTH = 380
const PREVIEW_MAX_HEIGHT = 440
const PREVIEW_SCROLL_STEP = 40
const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 6
const HOVER_LEAVE_DELAY_MS = 120
const HOVER_QUERY = '(hover: hover)'

interface PreviewGroup {
  readonly active: { readonly id: string; readonly pinned: boolean } | null
  readonly hover: (id: string, moved: boolean) => void
  readonly focus: (id: string) => void
  readonly toggle: (id: string) => void
  readonly release: (id: string) => void
  readonly dismiss: (id: string) => void
}
const PreviewContext = createContext<PreviewGroup | null>(null)

export function AbilityPreviewGroup({ children }: { readonly children: ReactNode }) {
  const [active, setActive] = useState<PreviewGroup['active']>(null)
  const suppressHover = useRef(false)
  const hover = useCallback((id: string, moved: boolean) => {
    if (moved) suppressHover.current = false
    if (!suppressHover.current) setActive(current => current?.id === id ? current : { id, pinned: false })
  }, [])
  const focus = useCallback((id: string) => { suppressHover.current = false; setActive(current => current?.id === id ? current : { id, pinned: false }) }, [])
  const toggle = useCallback((id: string) => { suppressHover.current = false; setActive(current => current?.id === id && current.pinned ? null : { id, pinned: true }) }, [])
  const release = useCallback((id: string) => setActive(current => current?.id === id && !current.pinned ? null : current), [])
  const dismiss = useCallback((id: string) => setActive(current => current?.id === id ? null : current), [])
  useEffect(() => {
    if (!active) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      // Removing a top-layer popup can expose another row under the stationary pointer
      suppressHover.current = true
      setActive(null)
    }
    document.addEventListener('keydown', escape, true)
    return () => document.removeEventListener('keydown', escape, true)
  }, [active])
  return <PreviewContext value={{ active, hover, focus, toggle, release, dismiss }}>{children}</PreviewContext>
}

export function AbilityPreview({ name, icon, cost, lines }: { readonly name: string; readonly icon: ReactNode; readonly cost: string; readonly lines: readonly string[] }) {
  const group = useContext(PreviewContext)
  if (!group) throw new Error('Ability previews need a preview group')
  const id = useId()
  const costId = `${id}-cost`
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const preview = useRef<HTMLDivElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const visible = group.active?.id === id
  const dismiss = group.dismiss
  useEffect(() => () => clearTimeout(leaveTimer.current), [])

  useLayoutEffect(() => {
    const popup = preview.current
    const button = trigger.current
    if (!visible || !popup || !button) return
    // The top layer keeps descriptions visible outside the inspector's scrolling container
    const viewport = window.visualViewport
    const position = () => {
      const anchor = button.getBoundingClientRect()
      const left = (viewport?.offsetLeft ?? 0) + VIEWPORT_MARGIN
      const top = (viewport?.offsetTop ?? 0) + VIEWPORT_MARGIN
      const right = left + (viewport?.width ?? window.innerWidth) - VIEWPORT_MARGIN * 2
      const bottom = top + (viewport?.height ?? window.innerHeight) - VIEWPORT_MARGIN * 2
      const width = Math.min(PREVIEW_WIDTH, right - left)
      popup.style.width = `${width}px`
      const below = Math.max(0, bottom - anchor.bottom - ANCHOR_GAP)
      const above = Math.max(0, anchor.top - top - ANCHOR_GAP)
      const height = Math.min(PREVIEW_MAX_HEIGHT, popup.scrollHeight + popup.offsetHeight - popup.clientHeight)
      const upwards = below < height && above > below
      popup.style.maxHeight = `${Math.min(PREVIEW_MAX_HEIGHT, upwards ? above : below)}px`
      popup.style.left = `${Math.max(left, Math.min(anchor.right - width, right - width))}px`
      popup.style.top = `${Math.max(top, upwards ? anchor.top - ANCHOR_GAP - popup.getBoundingClientRect().height : anchor.bottom + ANCHOR_GAP)}px`
    }
    popup.showPopover({ source: button })
    position()
    const pointerDown = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) dismiss(id) }
    const observer = new ResizeObserver(position)
    observer.observe(button)
    observer.observe(popup)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    viewport?.addEventListener('resize', position)
    viewport?.addEventListener('scroll', position)
    document.addEventListener('pointerdown', pointerDown)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      viewport?.removeEventListener('resize', position)
      viewport?.removeEventListener('scroll', position)
      document.removeEventListener('pointerdown', pointerDown)
      if (popup.matches(':popover-open')) popup.hidePopover()
    }
  }, [visible, lines, dismiss, id])

  return <span className="ability-preview" onPointerEnter={event => { clearTimeout(leaveTimer.current); if (event.pointerType !== 'touch' && window.matchMedia(HOVER_QUERY).matches) group.hover(id, false) }} onPointerMove={event => { if (event.pointerType !== 'touch' && window.matchMedia(HOVER_QUERY).matches) group.hover(id, event.movementX !== 0 || event.movementY !== 0) }} onPointerLeave={() => { leaveTimer.current = setTimeout(() => { if (document.activeElement !== trigger.current) group.release(id) }, HOVER_LEAVE_DELAY_MS) }} ref={root}>
    <button aria-describedby={`${costId}${visible ? ` ${id}` : ''}`} aria-expanded={visible} aria-label={`${name} details`} className="ability-preview__trigger" onBlur={() => dismiss(id)} onClick={() => group.toggle(id)} onFocus={() => group.focus(id)} onKeyDown={event => {
      const popup = preview.current
      if (!visible || !popup) return
      const offset = event.key === 'ArrowDown' ? PREVIEW_SCROLL_STEP : event.key === 'ArrowUp' ? -PREVIEW_SCROLL_STEP : event.key === 'PageDown' ? popup.clientHeight : event.key === 'PageUp' ? -popup.clientHeight : undefined
      if (offset !== undefined) { popup.scrollBy({ top: offset }); event.preventDefault() }
      else if (event.key === 'Home' || event.key === 'End') { popup.scrollTop = event.key === 'Home' ? 0 : popup.scrollHeight; event.preventDefault() }
    }} ref={trigger} type="button">{icon}<span>{name}</span><small id={costId}>{cost}</small></button>
    <div className="ability-preview__popup" id={id} popover="manual" ref={preview} role="tooltip"><strong>{name}</strong>{lines.length ? lines.map(line => <p key={line}>{line}</p>) : <p>Description not recorded.</p>}</div>
  </span>
}
