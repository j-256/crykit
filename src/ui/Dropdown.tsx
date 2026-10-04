import { useEffect, useRef, type PropsWithChildren, type RefObject } from 'react'

const VIEWPORT_MARGIN = 8
const ANCHOR_GAP = 6
const MIN_WIDTH = 360
const MAX_WIDTH = 480
const MAX_HEIGHT = 440
const COMPACT_MIN_WIDTH = 320
const COMPACT_MAX_WIDTH = 360
const openDropdowns: HTMLDivElement[] = []

export function Dropdown({ open, id, title, anchorRef, initialFocusRef, onClose, onDismiss, role = 'dialog', size = 'standard', className = '', children }: PropsWithChildren<{ open: boolean; id: string; title: string; anchorRef: RefObject<HTMLElement | null>; initialFocusRef: RefObject<HTMLElement | null>; onClose: () => void; onDismiss: () => void; role?: 'dialog' | 'listbox'; size?: 'standard' | 'compact'; className?: string }>) {
  const popupRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  const dismissRef = useRef(onDismiss)
  closeRef.current = onClose
  dismissRef.current = onDismiss

  useEffect(() => {
    const popup = popupRef.current
    const anchor = anchorRef.current
    if (!open || !popup || !anchor) return
    const viewport = window.visualViewport
    const position = () => {
      const bounds = anchor.getBoundingClientRect()
      const leftEdge = (viewport?.offsetLeft ?? 0) + VIEWPORT_MARGIN
      const topEdge = (viewport?.offsetTop ?? 0) + VIEWPORT_MARGIN
      const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - VIEWPORT_MARGIN * 2
      const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - VIEWPORT_MARGIN * 2
      const below = Math.max(0, bottomEdge - bounds.bottom - ANCHOR_GAP)
      const above = Math.max(0, bounds.top - topEdge - ANCHOR_GAP)
      const upwards = below < MAX_HEIGHT && above > below
      const minimumWidth = size === 'compact' ? COMPACT_MIN_WIDTH : MIN_WIDTH
      const maximumWidth = size === 'compact' ? COMPACT_MAX_WIDTH : MAX_WIDTH
      const width = Math.min(Math.max(bounds.width, minimumWidth), maximumWidth, rightEdge - leftEdge)
      const height = Math.min(MAX_HEIGHT, upwards ? above : below)
      popup.style.width = `${width}px`
      popup.style.maxHeight = `${height}px`
      popup.style.left = `${Math.max(leftEdge, Math.min(bounds.left, rightEdge - width))}px`
      popup.style.top = `${Math.max(topEdge, upwards ? bounds.top - ANCHOR_GAP - popup.getBoundingClientRect().height : bounds.bottom + ANCHOR_GAP)}px`
    }
    openDropdowns.push(popup)
    // Wait for the containing modal to enter the top layer before its dropdown
    const frame = window.requestAnimationFrame(() => {
      anchor.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
      popup.showPopover({ source: anchor })
      position()
      initialFocusRef.current?.focus({ preventScroll: true })
    })
    const isOutside = (target: EventTarget | null) => popup.matches(':popover-open') && target instanceof Node && !popup.contains(target) && !anchor.contains(target)
    let outsidePointerDown = false
    let restoreFocusOnCleanup = true
    const dismiss = () => {
      restoreFocusOnCleanup = false
      dismissRef.current()
    }
    const pointerDown = (event: PointerEvent) => { outsidePointerDown = openDropdowns.at(-1) === popup && event.isPrimary && event.button === 0 && isOutside(event.target) }
    const pointerCancel = () => { outsidePointerDown = false }
    const click = (event: MouseEvent) => {
      if (!outsidePointerDown || !isOutside(event.target)) return
      outsidePointerDown = false
      if (event.target instanceof Element && event.target.closest('[data-definition-trigger]')) return
      // A backdrop click dismisses this layer without also closing its modal
      if (event.target === anchor.closest('dialog')) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
      dismiss()
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || openDropdowns.at(-1) !== popup) return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeRef.current()
    }
    const focusIn = (event: FocusEvent) => {
      if (isOutside(event.target) && !outsidePointerDown) dismiss()
    }
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    observer.observe(popup)
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    viewport?.addEventListener('resize', position)
    viewport?.addEventListener('scroll', position)
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('pointercancel', pointerCancel, true)
    document.addEventListener('click', click, true)
    document.addEventListener('keydown', keyDown, true)
    document.addEventListener('focusin', focusIn, true)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', position)
      document.removeEventListener('scroll', position, true)
      viewport?.removeEventListener('resize', position)
      viewport?.removeEventListener('scroll', position)
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('pointercancel', pointerCancel, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('keydown', keyDown, true)
      document.removeEventListener('focusin', focusIn, true)
      const restoreFocus = popup.contains(document.activeElement) || document.activeElement === document.body
      const index = openDropdowns.indexOf(popup)
      if (index >= 0) openDropdowns.splice(index, 1)
      if (popup.matches(':popover-open')) popup.hidePopover()
      if (restoreFocusOnCleanup && restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true })
    }
  }, [anchorRef, initialFocusRef, open, size])

  return open ? <div aria-label={title} aria-modal={role === 'dialog' ? false : undefined} className={`definition-dropdown ${className}`} id={id} popover="manual" ref={popupRef} role={role}>{children}</div> : null
}
