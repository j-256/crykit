import { useEffect, type ReactNode } from 'react'
import type { CatalogSnapshot, Profile, ProfileId, RulesetRevisionId, ScenarioId } from '../domain/types'
import type { ProfileSummary } from '../interchange/types'
import { ContextSelectors } from './ContextSelectors'
import { Icon, type IconName } from './icons'
import { IconButton } from './components'
import { UniversalSearch } from './UniversalSearch'
import { parseAppRoute, routeDestination, routeForDestination, routeWithOverlay, useNavigation, type Destination } from './navigation'

export type { Destination } from './navigation'

interface MenuDestination { readonly id: Destination; readonly label: string; readonly icon: IconName }

const MAIN_DESTINATIONS: readonly MenuDestination[] = [
  { id: 'builds', label: 'Builds', icon: 'sword' },
  { id: 'characters', label: 'Characters', icon: 'character' },
  { id: 'reference', label: 'Reference', icon: 'tome' },
]
const TRACKING_DESTINATIONS: readonly MenuDestination[] = [
  { id: 'inventory', label: 'Inventory', icon: 'chest' },
  { id: 'progress', label: 'Progress', icon: 'crystal' },
]

function Brand() {
  return <div className="brand"><span className="brand__mark"><Icon name="crystal" /></span><span><strong className="brand__name">Crystal Companion</strong><span className="brand__tagline">A Crystal Project planner</span></span></div>
}

export function Shell({ profile, profiles, catalogs, destination, saveState, contextBusy, onSelectProfile, onSelectRuleset, onSelectScenario, onOpenData, children }: { profile: Profile; profiles: readonly ProfileSummary[]; catalogs: readonly CatalogSnapshot[]; destination: Destination; saveState: 'saved' | 'saving' | 'unsaved' | 'error'; contextBusy: boolean; onSelectProfile: (id: ProfileId) => Promise<void>; onSelectRuleset: (id: RulesetRevisionId) => Promise<void>; onSelectScenario: (id: ScenarioId | null) => Promise<void>; onOpenData: () => void; children: ReactNode }) {
  const navigation = useNavigation()
  const activeDestination = navigation.route.page.page === 'settings' ? undefined : destination
  const searchOpen = navigation.route.overlays.some((overlay) => overlay.kind === 'search')
  const saveLabel = saveState === 'saved' ? 'Saved locally' : saveState === 'saving' ? 'Saving locally' : saveState === 'error' ? 'Save failed' : 'Unsaved changes'
  const navigate = (next: Destination) => {
    navigation.navigate(routeForDestination(next))
  }
  const destinationButton = (item: MenuDestination) => <button aria-current={activeDestination === item.id ? 'page' : undefined} className="nav-link" key={item.id} onClick={() => navigate(item.id)} title={item.label} type="button"><Icon name={item.icon}/><span>{item.label}</span></button>
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
      <nav aria-label="Primary navigation" className="menu-window">
        <p className="menu-window__label">Menu</p>
        <ul aria-label="Builds, characters, and reference" className="nav-list">{MAIN_DESTINATIONS.map((item) => <li key={item.id}>{destinationButton(item)}</li>)}</ul>
        <div aria-label="Tracking" className="nav-tracking" role="group"><p className="nav-tracking__label">Tracking</p><ul className="nav-list">{TRACKING_DESTINATIONS.map((item) => <li key={item.id}>{destinationButton(item)}</li>)}</ul></div>
      </nav>
      <div className="rail__footer">
        <button className="nav-link rail__search" onClick={openSearch} type="button"><Icon name="search"/><span>Search</span><kbd aria-hidden="true">⌘/Ctrl K</kbd></button>
        <button aria-current={navigation.route.page.page === 'settings' ? 'page' : undefined} className="nav-link rail__data" onClick={onOpenData} type="button"><Icon name="settings"/><span>Data & settings</span></button>
        <div className="local-note"><strong>Your builds, your records</strong>Saved in this browser. Export a backup to keep a separate copy.</div>
      </div>
    </aside>
    <main className="main-shell">
      <header className="mobile-header"><Brand/><div className="mobile-header__actions"><IconButton icon="search" label="Search planner" onClick={openSearch}/><IconButton icon="settings" label="Open data and settings" onClick={onOpenData}/></div></header>
      <header className="context-bar">
        <ContextSelectors busy={contextBusy} onSelectProfile={onSelectProfile} onSelectRuleset={onSelectRuleset} onSelectScenario={onSelectScenario} profile={profile} profiles={profiles}/>
        <div aria-live="polite" className={`context-status context-status--${saveState}`}><span className="context-status__dot"/>{saveLabel}</div>
      </header>
      <div className="content">{children}</div>
    </main>
    <nav aria-label="Primary navigation" className="bottom-nav"><div aria-label="Builds, characters, and reference" className="bottom-nav__main" role="group">{MAIN_DESTINATIONS.map(destinationButton)}</div><div aria-label="Tracking" className="bottom-nav__tracking" role="group">{TRACKING_DESTINATIONS.map(destinationButton)}</div></nav>
    <UniversalSearch catalogs={catalogs} open={searchOpen}/>
  </div>
}

export function parseDestination() {
  return routeDestination(parseAppRoute(window.location.hash))
}
