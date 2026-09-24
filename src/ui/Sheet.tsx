import { useEffect, useId, useRef, type PropsWithChildren, type ReactNode } from 'react'
import { IconButton } from './components'

const openSheetStack: HTMLDialogElement[] = []
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
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

export function Sheet({ open, title, description, onClose, onRequestClose, footer, children, width = 'standard' }: PropsWithChildren<{ open: boolean; title: string; description?: string; onClose: () => void; onRequestClose?: () => boolean; footer?: ReactNode; width?: 'standard' | 'wide' }>) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  const onRequestCloseRef = useRef(onRequestClose)
  onCloseRef.current = onClose
  onRequestCloseRef.current = onRequestClose

  const requestClose = () => {
    if (onRequestCloseRef.current?.() === false) return
    dialogRef.current?.close()
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!open || !dialog) return
    if (!dialog.open) dialog.showModal()
    const handleClose = () => onCloseRef.current()
    const handleCancel = (event: Event) => {
      event.preventDefault()
      requestClose()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
      if (openSheetStack.at(-1) !== dialog) return
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
    const existingStackIndex = openSheetStack.indexOf(dialog)
    if (existingStackIndex >= 0) openSheetStack.splice(existingStackIndex, 1)
    openSheetStack.push(dialog)
    dialog.addEventListener('close', handleClose)
    dialog.addEventListener('cancel', handleCancel)
    dialog.addEventListener('keydown', handleKeyDown)
    document.body.classList.add('has-sheet')
    return () => {
      dialog.removeEventListener('close', handleClose)
      dialog.removeEventListener('cancel', handleCancel)
      dialog.removeEventListener('keydown', handleKeyDown)
      const stackIndex = openSheetStack.indexOf(dialog)
      if (stackIndex >= 0) openSheetStack.splice(stackIndex, 1)
      if (dialog.open) dialog.close()
      if (!document.querySelector('dialog.sheet-dialog[open]')) document.body.classList.remove('has-sheet')
    }
  }, [open])

  if (!open) return null
  return <dialog aria-describedby={description ? descriptionId : undefined} aria-labelledby={titleId} className={`sheet-dialog sheet-dialog--${width}`} ref={dialogRef}><section className="sheet"><header className="sheet__header"><div><p className="eyebrow">Workspace panel</p><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><IconButton icon="close" label="Close panel" onClick={requestClose}/></header><div className="sheet__body">{children}</div>{footer && <footer className="sheet__footer">{footer}</footer>}</section></dialog>
}
