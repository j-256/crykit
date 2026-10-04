import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { BuildModRequirement } from '../domain/build-mods'
import { ModStateBadge } from './DefinitionModLabel'

const TOOLTIP_WIDTH = 360
const TOOLTIP_MAX_HEIGHT = 440
const TOOLTIP_SCROLL_STEP = 40
const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 6
const HOVER_LEAVE_DELAY_MS = 120

export function BuildModsBadge({ buildTitle, requirements }: { readonly buildTitle: string; readonly requirements: readonly BuildModRequirement[] }) {
  const id = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const hoverLeaveRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const visible = requirements.length > 0 && !dismissed && (hovered || focused || pinned)
  const tone = requirements.some(mod => mod.state === 'disabled' || mod.state === 'conflicting') ? 'danger' : requirements.some(mod => mod.state === 'unknown') ? 'warning' : 'info'

  useEffect(() => () => clearTimeout(hoverLeaveRef.current), [])

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current
    const trigger = triggerRef.current
    if (!visible || !tooltip || !trigger) return
    const viewport = window.visualViewport
    const position = () => {
      const anchor = trigger.getBoundingClientRect()
      const leftEdge = (viewport?.offsetLeft ?? 0) + VIEWPORT_MARGIN
      const topEdge = (viewport?.offsetTop ?? 0) + VIEWPORT_MARGIN
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - VIEWPORT_MARGIN * 2
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - VIEWPORT_MARGIN * 2
      const below = Math.max(0, bottomEdge - anchor.bottom - ANCHOR_GAP)
      const above = Math.max(0, anchor.top - topEdge - ANCHOR_GAP)
      const width = Math.min(TOOLTIP_WIDTH, rightEdge - leftEdge)
      tooltip.style.width = `${width}px`
      const contentHeight = Math.min(TOOLTIP_MAX_HEIGHT, tooltip.scrollHeight + tooltip.offsetHeight - tooltip.clientHeight)
      const upwards = below < contentHeight && above > below
      tooltip.style.maxHeight = `${Math.min(TOOLTIP_MAX_HEIGHT, upwards ? above : below)}px`
      tooltip.style.left = `${Math.max(leftEdge, Math.min(anchor.right - width, rightEdge - width))}px`
      tooltip.style.top = `${Math.max(topEdge, upwards ? anchor.top - ANCHOR_GAP - tooltip.getBoundingClientRect().height : anchor.bottom + ANCHOR_GAP)}px`
    }
    tooltip.showPopover({ source: trigger })
    position()
    const dismiss = () => { setPinned(false); setDismissed(true) }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      dismiss()
    }
    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) dismiss()
    }
    const observer = new ResizeObserver(position)
    observer.observe(trigger)
    observer.observe(tooltip)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    viewport?.addEventListener('resize', position)
    viewport?.addEventListener('scroll', position)
    document.addEventListener('keydown', keyDown)
    document.addEventListener('pointerdown', pointerDown)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      viewport?.removeEventListener('resize', position)
      viewport?.removeEventListener('scroll', position)
      document.removeEventListener('keydown', keyDown)
      document.removeEventListener('pointerdown', pointerDown)
      if (tooltip.matches(':popover-open')) tooltip.hidePopover()
    }
  }, [requirements, visible])

  if (!requirements.length) return null
  return <span className="build-mods-badge" onClick={event => event.stopPropagation()} onPointerEnter={event => { clearTimeout(hoverLeaveRef.current); if (event.pointerType !== 'touch') { setHovered(true); setDismissed(false) } }} onPointerLeave={() => { hoverLeaveRef.current = setTimeout(() => setHovered(false), HOVER_LEAVE_DELAY_MS) }} ref={rootRef}>
    <button aria-describedby={id} aria-expanded={visible} aria-label={`Mods for ${buildTitle}`} className={`badge badge--${tone} build-mods-badge__trigger`} onBlur={() => { setFocused(false); setPinned(false) }} onClick={() => { setPinned(!pinned); setDismissed(pinned) }} onFocus={() => { setFocused(true); setDismissed(false) }} onKeyDown={event => {
      const tooltip = tooltipRef.current
      if (!visible || !tooltip) return
      const offset = event.key === 'ArrowDown' ? TOOLTIP_SCROLL_STEP : event.key === 'ArrowUp' ? -TOOLTIP_SCROLL_STEP : event.key === 'PageDown' ? tooltip.clientHeight : event.key === 'PageUp' ? -tooltip.clientHeight : undefined
      if (offset !== undefined) { tooltip.scrollBy({ top: offset }); event.preventDefault() }
      else if (event.key === 'Home' || event.key === 'End') { tooltip.scrollTop = event.key === 'Home' ? 0 : tooltip.scrollHeight; event.preventDefault() }
    }} ref={triggerRef} type="button">Mods</button>
    <div className="build-mods-badge__tooltip" id={id} popover="manual" ref={tooltipRef} role="tooltip">
      <strong>Mods required by this Build</strong>
      <ul>{requirements.map(mod => <li key={mod.projectId ?? mod.name}>
        <span className="build-mods-badge__heading"><strong>{mod.name}</strong><ModStateBadge disabledLabel="Disabled in this Build's setup" state={mod.state}/></span>
        <span>Affects: {mod.selections.join(', ')}</span>
      </li>)}</ul>
    </div>
  </span>
}
