import type { KeyboardEvent } from 'react'
import { MOD_WORKSPACE_PAGES, type ModWorkspaceView } from './mod-workspace'
import './mod-workspace.css'

export function ModWorkspaceNavigation({ id, view, onChange, disabled = [], includeLibrary = true }: { readonly id: string; readonly view: ModWorkspaceView; readonly onChange: (view: ModWorkspaceView) => void; readonly disabled?: readonly ModWorkspaceView[]; readonly includeLibrary?: boolean }) {
  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    // Skip protected destinations so arrow navigation cannot leave a pending editor draft
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')]
    const index = tabs.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    let next: HTMLButtonElement | undefined
    switch (event.key) {
      case 'ArrowLeft': next = tabs[(index + tabs.length - 1) % tabs.length]; break
      case 'ArrowRight': next = tabs[(index + 1) % tabs.length]; break
      case 'Home': next = tabs[0]; break
      case 'End': next = tabs.at(-1); break
      default: return
    }
    event.preventDefault()
    next?.click()
    next?.focus()
  }
  return <div className="segmented mod-workspace-tabs" role="tablist" aria-label="Mods workspace" onKeyDown={navigateTabs}>{MOD_WORKSPACE_PAGES.filter(item => includeLibrary || item.id !== 'library').map(item => <button key={item.id} type="button" role="tab" id={`${id}-${item.id}-tab`} aria-controls={`${id}-${item.id}-panel`} aria-selected={view === item.id} tabIndex={view === item.id ? 0 : -1} disabled={disabled.includes(item.id)} onClick={() => onChange(item.id)}>{item.label}</button>)}</div>
}
