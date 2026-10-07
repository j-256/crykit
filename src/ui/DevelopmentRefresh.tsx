import { IconButton } from './components'

export function DevelopmentRefresh({ blocked, onRefresh }: { blocked: boolean; onRefresh: () => void }) {
  if (!import.meta.env.DEV) return null
  const port = window.location.port
  return <div className="development-controls">
    {port && <span role="note" aria-label={`Development server port ${port}`} className="development-port">Port {port}</span>}
    <IconButton className="development-refresh" disabled={blocked} icon="refresh" label="Reload development app" onClick={() => { if (!blocked) onRefresh() }} title={blocked ? 'Save or discard edits and resolve failed saves before reloading.' : 'Reload to load the latest app files.'}/>
  </div>
}
