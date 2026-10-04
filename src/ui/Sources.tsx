import { createContext, useContext, useId, useRef, useState, type PropsWithChildren } from 'react'
import { IconButton } from './components'
import { Dropdown } from './Dropdown'
import './sources.css'

const SourcesContext = createContext(false)
type SourcesProps = PropsWithChildren<{ label?: string; title?: string }>

function SourcesPopup({ label = 'Sources', title = label, children }: SourcesProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const close = () => setOpen(false)
  return <>
    <IconButton aria-controls={open ? id : undefined} aria-expanded={open} aria-haspopup="dialog" className="sources-trigger" icon="sources" label={label} onClick={() => setOpen(value => !value)} ref={anchorRef}/>
    <Dropdown anchorRef={anchorRef} className="sources-popup" id={id} initialFocusRef={headingRef} onClose={close} onDismiss={close} open={open} size="compact" title={title}>
      <header className="sources-popup__header"><h3 ref={headingRef} tabIndex={-1}>{title}</h3><IconButton icon="close" label="Close sources" onClick={close}/></header>
      <div className="sources-popup__body"><SourcesContext value={true}>{children}</SourcesContext></div>
    </Dropdown>
  </>
}

export function Sources({ label = 'Sources', title, children }: SourcesProps) {
  const nested = useContext(SourcesContext)
  if (!nested) return <SourcesPopup label={label} title={title}>{children}</SourcesPopup>
  const heading = title ?? (label === 'Sources' ? undefined : label)
  return <div className="sources-inline">{heading && <h4>{heading}</h4>}{children}</div>
}
