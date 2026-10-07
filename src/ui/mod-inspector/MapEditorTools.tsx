import type { KeyboardEvent } from 'react'
import { Icon, type IconName } from '../icons'
import { IconButton } from '../components'

export type MapEditorTool = 'move' | 'paint' | 'erase' | 'platform'
export const MAP_EDITOR_TOOLS: readonly { readonly value: MapEditorTool; readonly label: string; readonly icon: IconName; readonly shortcut: string }[] = Object.freeze([
  { value: 'move', label: 'Move / pan', icon: 'move', shortcut: 'V' },
  { value: 'paint', label: 'Paint blocks', icon: 'paintbrush', shortcut: 'B' },
  { value: 'erase', label: 'Erase blocks', icon: 'eraser', shortcut: 'E' },
  { value: 'platform', label: 'Voxel platform', icon: 'box', shortcut: 'F' },
])

function acceptsShortcut(event: KeyboardEvent): boolean {
  // Keep shortcuts local to the focused editor and preserve text-field history and composing input
  return !event.defaultPrevented && !event.repeat && !event.nativeEvent.isComposing && event.target instanceof Element && !event.target.closest('input, select, textarea, [contenteditable]:not([contenteditable="false"])')
}

export function isMapShortcut(event: KeyboardEvent): boolean {
  return acceptsShortcut(event) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
}

export function mapHistoryShortcut(event: KeyboardEvent): 'undo' | 'redo' | undefined {
  if (!acceptsShortcut(event) || event.altKey || !(event.ctrlKey || event.metaKey)) return undefined
  if (event.key.toLowerCase() === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (event.key.toLowerCase() === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo'
  return undefined
}

export interface MapEditorHistory { readonly canUndo: boolean; readonly canRedo: boolean; readonly onUndo: () => void; readonly onRedo: () => void }
interface Props { readonly tool: MapEditorTool; readonly plane: boolean; readonly disabled: boolean; readonly history: MapEditorHistory; readonly onTool: (tool: MapEditorTool) => void; readonly onPlane: () => void }
export default function MapEditorTools({ tool, plane, disabled, history, onTool, onPlane }: Props) {
  return <div className="map-editor-tool-strip">
    <div className="map-editor-tools" role="group" aria-label="Map editing tool">
      {MAP_EDITOR_TOOLS.map(option => <button key={option.value} type="button" className="icon-button map-editor-tool" aria-label={option.label} title={`${option.label} (${option.shortcut})`} aria-keyshortcuts={option.shortcut} aria-pressed={tool === option.value} disabled={disabled} onClick={() => onTool(option.value)}><Icon name={option.icon}/><kbd aria-hidden="true">{option.shortcut}</kbd></button>)}
      <button type="button" className="icon-button map-editor-tool" aria-label="Construction plane" title="Construction plane (P): paint in empty space" aria-keyshortcuts="P" aria-pressed={plane} disabled={disabled} onClick={onPlane}><Icon name="plane"/><kbd aria-hidden="true">P</kbd></button>
    </div>
    <div className="map-editor-history" role="group" aria-label="Map edit history">
      <IconButton icon="undo" label="Undo map edit" title="Undo map edit (Ctrl/Cmd+Z)" aria-keyshortcuts="Control+Z Meta+Z" disabled={!history.canUndo} onClick={history.onUndo}/>
      <IconButton icon="redo" label="Redo map edit" title="Redo map edit (Ctrl/Cmd+Shift+Z or Ctrl+Y)" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y" disabled={!history.canRedo} onClick={history.onRedo}/>
    </div>
    <span className="map-editor-active-tool">{plane ? 'Paint on plane' : MAP_EDITOR_TOOLS.find(option => option.value === tool)?.label}</span>
  </div>
}
