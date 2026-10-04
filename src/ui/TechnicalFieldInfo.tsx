import { useId, useState } from 'react'
import { Icon } from './icons'

export function TechnicalFieldInfo({ field, label }: { readonly field: string; readonly label: string }) {
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const visible = !dismissed && (hovered || focused || pinned)
  return <span className="technical-field-info" onPointerEnter={event => { if (event.pointerType !== 'touch') { setHovered(true); setDismissed(false) } }} onPointerLeave={() => setHovered(false)}>
    <button aria-describedby={id} aria-label={`Technical name for ${label}`} onBlur={() => { setFocused(false); setPinned(false) }} onClick={() => { setPinned(!pinned); setDismissed(pinned) }} onFocus={() => { setFocused(true); setDismissed(false) }} onKeyDown={event => {
      if (event.key === 'Escape') { setPinned(false); setDismissed(true); event.preventDefault(); event.stopPropagation() }
    }} type="button"><Icon name="info"/></button>
    <span className="technical-field-info__tooltip" hidden={!visible} id={id} role="tooltip">Technical field: <code>{field}</code></span>
  </span>
}
