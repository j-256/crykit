import type { ReactNode } from 'react'
import type { Profile } from '../domain/types'
import { activeRuleset } from './model'
import { Icon, type IconName } from './icons'
import { IconButton } from './components'

export type Destination = 'inventory' | 'characters' | 'builds' | 'progress' | 'reference'

const destinations: readonly { id: Destination; label: string; icon: IconName }[] = [
  { id: 'inventory', label: 'Inventory', icon: 'box' },
  { id: 'characters', label: 'Characters', icon: 'user' },
  { id: 'builds', label: 'Builds & teams', icon: 'layers' },
  { id: 'progress', label: 'Progress', icon: 'compass' },
  { id: 'reference', label: 'Reference', icon: 'book' },
]

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><span className="brand__mark"><Icon name="compass" /></span><span><strong className="brand__name">Crystal Companion</strong><span className="brand__tagline">{compact ? 'Local expedition record' : 'Inventory & party planner'}</span></span></div>
}

export function Shell({ profile, destination, saveState, onNavigate, onOpenData, children }: { profile: Profile; destination: Destination; saveState: 'saved' | 'saving' | 'unsaved' | 'error'; onNavigate: (destination: Destination) => void; onOpenData: () => void; children: ReactNode }) {
  const ruleset = activeRuleset(profile)
  const scenario = profile.activeScenarioId ? profile.scenarios[profile.activeScenarioId] : undefined
  const saveLabel = saveState === 'saved' ? 'Saved locally' : saveState === 'saving' ? 'Saving locally' : saveState === 'error' ? 'Save failed' : 'Unsaved changes'
  const navigate = (next: Destination) => {
    onNavigate(next)
  }

  return <div className="app-shell">
    <aside className="rail">
      <Brand />
      <div className="rail__rule" />
      <nav aria-label="Primary navigation"><ul className="nav-list">{destinations.map((item) => <li key={item.id}><button aria-current={destination === item.id ? 'page' : undefined} className="nav-link" onClick={() => navigate(item.id)} type="button"><Icon name={item.icon}/><span>{item.label}</span></button></li>)}</ul></nav>
      <div className="rail__footer">
        <button className="nav-link rail__data" onClick={onOpenData} type="button"><Icon name="settings"/><span>Data & settings</span></button>
        <div className="local-note"><strong>Private by default</strong>Your records stay in this browser until you export them.</div>
      </div>
    </aside>
    <main className="main-shell">
      <header className="mobile-header"><Brand compact/><IconButton icon="settings" label="Open data and settings" onClick={onOpenData}/></header>
      <header className="context-bar">
        <div className="context-bar__group">
          <div className="context-item context-item--profile"><Icon name="archive"/><span><span className="context-item__label">Playthrough</span><span className="context-item__value">{profile.label}</span></span></div>
          <div className="context-item context-item--ruleset"><Icon name="shield"/><span><span className="context-item__label">Ruleset</span><span className="context-item__value">{ruleset?.label ?? 'Not configured'}</span></span></div>
          {(destination === 'builds' || scenario) && <div className="context-item context-item--scenario"><Icon name="team"/><span><span className="context-item__label">Scenario</span><span className="context-item__value">{scenario?.label ?? 'None selected'}</span></span></div>}
        </div>
        <div aria-live="polite" className={`context-status context-status--${saveState}`}><span className="context-status__dot"/>{saveLabel}</div>
      </header>
      <div className="content">{children}</div>
    </main>
    <nav aria-label="Primary navigation" className="bottom-nav">{destinations.map((item) => <button aria-current={destination === item.id ? 'page' : undefined} key={item.id} onClick={() => navigate(item.id)} type="button"><Icon name={item.icon}/><span>{item.label.replace(' & teams', '')}</span></button>)}</nav>
  </div>
}

export function parseDestination() {
  const route = window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0]
  return destinations.some((item) => item.id === route) ? route as Destination : 'inventory'
}
