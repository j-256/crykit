import { useEffect, useId, useRef, type PropsWithChildren, type ReactNode, type RefObject } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { IconButton } from './components'

interface OpenSheet {
  readonly dialog: HTMLDialogElement
  readonly layer: number
  readonly order: number
}

const openSheetStack: OpenSheet[] = []
const shownSheetOrder: HTMLDialogElement[] = []
const reorderingSheets = new WeakSet<HTMLDialogElement>()
let nextSheetOrder = 0
let sheetOpenScheduled = false

function forgetShownSheet(dialog: HTMLDialogElement) {
  const index = shownSheetOrder.indexOf(dialog)
  if (index >= 0) shownSheetOrder.splice(index, 1)
}

function showSheet(dialog: HTMLDialogElement) {
  if (dialog.open || !dialog.isConnected) return
  dialog.showModal()
  forgetShownSheet(dialog)
  shownSheetOrder.push(dialog)
}

function scheduleSheetOpen() {
  if (sheetOpenScheduled) return
  sheetOpenScheduled = true
  window.queueMicrotask(() => {
    sheetOpenScheduled = false
    openSheetStack.sort((left, right) => left.layer - right.layer || left.order - right.order)
    const desired = openSheetStack.map((entry) => entry.dialog).filter((dialog) => dialog.isConnected)
    const actual = shownSheetOrder.filter((dialog) => dialog.isConnected && dialog.open)
    shownSheetOrder.splice(0, shownSheetOrder.length, ...actual)
    const requiresReorder = actual.some((dialog, index) => desired[index] !== dialog)
    if (requiresReorder) {
      for (const dialog of actual) {
        reorderingSheets.add(dialog)
        forgetShownSheet(dialog)
        dialog.close()
      }
    }
    for (const dialog of desired) showSheet(dialog)
  })
}
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  // Native disclosure controls belong in the dialog's keyboard cycle
  'summary',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(dialog: HTMLDialogElement) {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled')) return false
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
  })
}

export function Sheet({ open, title, description, onClose, onRequestClose, footer, children, width = 'standard', universalSearch = false, layer = 0, initialFocusRef }: PropsWithChildren<{ open: boolean; title: string; description?: string; onClose: () => void; onRequestClose?: () => boolean; footer?: ReactNode; width?: 'standard' | 'wide' | 'command'; universalSearch?: boolean; layer?: number; initialFocusRef?: RefObject<HTMLElement | null> }>) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeNotifiedRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const onRequestCloseRef = useRef(onRequestClose)
  onCloseRef.current = onClose
  onRequestCloseRef.current = onRequestClose

  const requestClose = () => {
    if (closeNotifiedRef.current) return
    if (onRequestCloseRef.current?.() === false) return
    closeNotifiedRef.current = true
    if (dialogRef.current) forgetShownSheet(dialogRef.current)
    dialogRef.current?.close()
    // Native close events arrive later; synchronize state before a shortcut can reopen
    flushSync(() => onCloseRef.current())
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog) return
    // Native autofocus runs when showModal opens the dialog, after React mounts it
    if (initialFocusRef?.current) initialFocusRef.current.autofocus = true
    closeNotifiedRef.current = false
    let backdropPointerDown = false
    const isBackdrop = (event: MouseEvent) => {
      if (event.target !== dialog || openSheetStack.at(-1)?.dialog !== dialog) return false
      const bounds = dialog.getBoundingClientRect()
      return event.clientX < bounds.left || event.clientX >= bounds.right || event.clientY < bounds.top || event.clientY >= bounds.bottom
    }
    const handlePointerDown = (event: PointerEvent) => {
      backdropPointerDown = event.isPrimary && event.button === 0 && isBackdrop(event)
    }
    const handlePointerCancel = () => { backdropPointerDown = false }
    const handleClick = (event: MouseEvent) => {
      const dismiss = backdropPointerDown && isBackdrop(event)
      backdropPointerDown = false
      if (!dismiss) return
      event.preventDefault()
      event.stopPropagation()
      requestClose()
    }
    const handleClose = () => {
      if (reorderingSheets.delete(dialog)) return
      if (dialog.open) return
      forgetShownSheet(dialog)
      if (closeNotifiedRef.current) return
      closeNotifiedRef.current = true
      onCloseRef.current()
    }
    const handleCancel = (event: Event) => {
      event.preventDefault()
      requestClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openSheetStack.at(-1)?.dialog === dialog) {
        event.preventDefault()
        event.stopPropagation()
        requestClose()
        return
      }
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
      if (openSheetStack.at(-1)?.dialog !== dialog) return
      const focusable = focusableElements(dialog)
      const first = focusable[0]
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const active = document.activeElement
      if (event.shiftKey ? active === first || !dialog.contains(active) : active === last || !dialog.contains(active)) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
      }
    }
    const existingStackIndex = openSheetStack.findIndex((entry) => entry.dialog === dialog)
    if (existingStackIndex >= 0) openSheetStack.splice(existingStackIndex, 1)
    openSheetStack.push({ dialog, layer, order: nextSheetOrder++ })
    scheduleSheetOpen()
    dialog.addEventListener('close', handleClose)
    dialog.addEventListener('cancel', handleCancel)
    dialog.addEventListener('keydown', handleKeyDown)
    dialog.addEventListener('pointerdown', handlePointerDown)
    dialog.addEventListener('pointercancel', handlePointerCancel)
    dialog.addEventListener('click', handleClick)
    document.body.classList.add('has-sheet')
    return () => {
      dialog.removeEventListener('close', handleClose)
      dialog.removeEventListener('cancel', handleCancel)
      dialog.removeEventListener('keydown', handleKeyDown)
      dialog.removeEventListener('pointerdown', handlePointerDown)
      dialog.removeEventListener('pointercancel', handlePointerCancel)
      dialog.removeEventListener('click', handleClick)
      const stackIndex = openSheetStack.findIndex((entry) => entry.dialog === dialog)
      if (stackIndex >= 0) openSheetStack.splice(stackIndex, 1)
      forgetShownSheet(dialog)
      if (dialog.open) dialog.close()
      if (!document.querySelector('dialog.sheet-dialog[open]')) document.body.classList.remove('has-sheet')
    }
  }, [initialFocusRef, layer, open])

  if (!open) return null
  return createPortal(<dialog aria-describedby={description ? descriptionId : undefined} aria-labelledby={titleId} className={`sheet-dialog sheet-dialog--${width}`} data-sheet-layer={layer} data-universal-search={universalSearch ? 'true' : undefined} ref={dialogRef}><section className="sheet"><header className="sheet__header"><div><p className="eyebrow">Crystal Kit</p><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><IconButton icon="close" label="Close dialog" onClick={requestClose}/></header><div className="sheet__body">{children}</div>{footer && <footer className="sheet__footer">{footer}</footer>}</section></dialog>, document.body)
}
