import { useId, useRef, useState, type ReactNode } from 'react'
import { Button } from './components'
import { Dropdown } from './Dropdown'

export function WorkspaceMoreActions({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  return <>
    <Button aria-controls={open ? id : undefined} aria-expanded={open} aria-haspopup="dialog" icon="more" onClick={() => setOpen(value => !value)} ref={anchorRef} title={title} tone="secondary" type="button">More</Button>
    <Dropdown anchorRef={anchorRef} id={id} initialFocusRef={contentRef} onClose={() => setOpen(false)} onDismiss={() => setOpen(false)} open={open} title={title}>
      <div className="workspace-more workspace-more--actions" ref={contentRef} tabIndex={-1}>{children}</div>
    </Dropdown>
  </>
}
