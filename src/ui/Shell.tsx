import { useEffect, type ReactNode } from 'react'
import type { CatalogSnapshot, Profile } from '../domain/types'
import { activeRuleset } from './model'
import { Icon, type IconName } from './icons'
import { IconButton } from './components'
import { UniversalSearch } from './UniversalSearch'
import { parseAppRoute, routeDestination, routeForDestination, routeWithOverlay, useNavigation, type Destination } from './navigation'

export type { Destination } from './navigation'

const destinations: readonly { id: Destination; label: string; icon: IconName }[] = [
  { id: 'inventory', label: 'Inventory', icon: 'chest' },
  { id: 'characters', label: 'Characters', icon: 'character' },
  { id: 'builds', label: 'Builds & teams', icon: 'sword' },
  { id: 'progress', label: 'Progress', icon: 'crystal' },
  { id: 'reference', label: 'Reference', icon: 'tome' },
]

function Brand() {
  return <div className="brand"><span className="brand__mark"><Icon name="crystal" /></span><span><strong className="brand__name">Crystal Companion</strong><span className="brand__tagline">A Crystal Project planner</span></span></div>
}

export function Shell({ profile, catalogs, destination, saveState, onOpenData, children }: { profile: Profile; catalogs: readonly CatalogSnapshot[]; destination: Destination; saveState: 'saved' | 'saving' | 'unsaved' | 'error'; onOpenData: () => void; children: ReactNode }) {
  const navigation = useNavigation()
  const ruleset = activeRuleset(profile)
  const scenario = profile.activeScenarioId ? profile.scenarios[profile.activeScenarioId] : undefined
  const searchOpen = navigation.route.overlays.some((overlay) => overlay.kind === 'search')
  const saveLabel = saveState === 'saved' ? 'Saved locally' : saveState === 'saving' ? 'Saving locally' : saveState === 'error' ? 'Save failed' : 'Unsaved changes'
  const navigate = (next: Destination) => {
    navigation.navigate(routeForDestination(next))
  }
  const openSearch = () => {
    if (searchOpen) return
    navigation.navigate(routeWithOverlay(navigation.route, { kind: 'search', query: '' }))
  }
  useEffect(() => {
    const handleSearchShortcut = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLocaleLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey) || event.altKey) return
      event.preventDefault()
      openSearch()
    }
    window.addEventListener('keydown', handleSearchShortcut)
    return () => window.removeEventListener('keydown', handleSearchShortcut)
  })

  return <div className="app-shell">
    <aside className="rail">
      <Brand />
      <nav aria-label="Primary navigation" className="menu-window"><p className="menu-window__label">Menu</p><ul className="nav-list">{destinations.map((item) => <li key={item.id}><button aria-current={destination === item.id ? 'page' : undefined} className="nav-link" onClick={() => navigate(item.id)} type="button"><Icon name={item.icon}/><span>{item.label}</span></button></li>)}</ul></nav>
      <div className="rail__footer">
        <button className="nav-link rail__search" onClick={openSearch} type="button"><Icon name="search"/><span>Search</span><kbd aria-hidden="true">⌘/Ctrl K</kbd></button>
        <button className="nav-link rail__data" onClick={onOpenData} type="button"><Icon name="settings"/><span>Data & settings</span></button>
        <div className="local-note"><strong>Your playthrough, your records</strong>Saved in this browser. Export a backup to keep a separate copy.</div>
      </div>
    </aside>
    <main className="main-shell">
      <header className="mobile-header"><Brand/><div className="mobile-header__actions"><IconButton icon="search" label="Search planner" onClick={openSearch}/><IconButton icon="settings" label="Open data and settings" onClick={onOpenData}/></div></header>
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
    <UniversalSearch catalogs={catalogs} open={searchOpen}/>
  </div>
}

export function parseDestination() {
  return routeDestination(parseAppRoute(window.location.hash))
}
