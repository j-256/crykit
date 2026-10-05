import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import crystalCricketUrl from '../assets/crystal-cricket.svg'
import type { CatalogSnapshot, LocalData, PlaythroughId, ScenarioId } from '../domain/types'
import { ContextSelectors } from './ContextSelectors'
import { DevelopmentRefresh } from './DevelopmentRefresh'
import { Icon, type IconName } from './icons'
import { IconButton } from './components'
import { UniversalSearch } from './UniversalSearch'
import { ProgressBoards } from './ProgressBoards'
import { PreviewNotice } from './PreviewNotice'
import { WorkspaceHeaderContext } from './WorkspaceHeader'
import { parseAppRoute, routeDestination, routeForDestination, routeWithOverlay, useNavigation, type Destination } from './navigation'

export type { Destination } from './navigation'

interface MenuDestination { readonly id: Destination; readonly label: string; readonly icon: IconName }

const MAIN_DESTINATIONS: readonly MenuDestination[] = [
  { id: 'builds', label: 'Builds', icon: 'sword' },
  { id: 'teams', label: 'Teams', icon: 'team' },
  { id: 'reference', label: 'Reference', icon: 'tome' },
  { id: 'map', label: 'World Map', icon: 'compass' },
  { id: 'mods', label: 'Mods', icon: 'edit' },
  { id: 'save-editor', label: 'Save editor', icon: 'archive' },
]
const TRACKING_DESTINATIONS: readonly MenuDestination[] = [
  { id: 'characters', label: 'Characters', icon: 'character' },
  { id: 'inventory', label: 'Inventory', icon: 'chest' },
  { id: 'progress', label: 'Progress', icon: 'crystal' },
]

function Brand() {
  return <div className="brand">
    <span className="brand__mark"><Icon name="crystal" /></span>
    <span>
      <strong className="brand__name">
        <span>Crystal </span>
        <span className="brand__kit"><span>Kit</span><img alt="" className="brand__cricket" src={crystalCricketUrl}/></span>
      </strong>
      <span className="brand__tagline">A Crystal Project planner</span>
    </span>
  </div>
}

export function Shell({ localData, catalogs, destination, saveState, contextBusy, developmentRefreshBlocked, onDevelopmentRefresh, onSelectPlaythrough, onSelectScenario, onOpenData, children }: { localData: LocalData; catalogs: readonly CatalogSnapshot[]; destination: Destination; saveState: 'saved' | 'saving' | 'unsaved' | 'error'; contextBusy: boolean; developmentRefreshBlocked: boolean; onDevelopmentRefresh: () => void; onSelectPlaythrough: (id: PlaythroughId) => Promise<void>; onSelectScenario: (id: ScenarioId | null) => Promise<void>; onOpenData: () => void; children: ReactNode }) {
  const navigation = useNavigation()
  const [sidebarExpanded, setSidebarExpanded] = useState(true)
  const [headerTarget, setHeaderTarget] = useState<HTMLElement | null>(null)
  const [unsavedObject, setUnsavedObject] = useState(false)
  const [primaryTarget, setPrimaryTarget] = useState<HTMLElement | null>(null)
  const contextRef = useRef<HTMLElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const bottomNavRef = useRef<HTMLElement>(null)
  const partyPage = navigation.route.page.page === 'builds' && ['teams', 'scenario', 'scenario-new'].includes(navigation.route.page.view)
  const tracking = (navigation.route.page.page === 'teams' && navigation.route.page.view === 'adopt') || partyPage || TRACKING_DESTINATIONS.some(item => item.id === destination)
  const headerSlots = useMemo(() => tracking ? null : { active: true, target: headerTarget, primaryTarget, setPrimaryTarget, setUnsavedObject }, [tracking, headerTarget, primaryTarget])
  const activeDestination = navigation.route.page.page === 'settings' ? undefined : partyPage ? 'characters' : destination
  const searchOpen = navigation.route.overlays.some((overlay) => overlay.kind === 'search')
  const page = navigation.route.page
  const sharedSnapshot = page.page === 'share'
  const newPlan = unsavedObject || (page.page === 'builds' && page.view === 'build-new') || (page.page === 'teams' && page.view === 'new')
  const saveLabel = sharedSnapshot ? 'Read-only snapshot' : saveState === 'saved' ? newPlan ? 'Not yet saved' : 'Saved locally' : saveState === 'saving' ? 'Saving locally' : saveState === 'error' ? 'Save failed' : 'Unsaved changes'
  const saveExplanation = sharedSnapshot ? 'This shared snapshot has not been saved to this browser. Choose Save a copy to keep it.' : newPlan && saveState === 'saved' ? 'This new plan has not been saved to this browser.' : saveLabel
  const statusState = sharedSnapshot || (newPlan && saveState === 'saved') ? 'unsaved' : saveState
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
  useEffect(() => {
    const context = contextRef.current
    const main = mainRef.current
    if (!context || !main) return
    const measure = () => main.style.setProperty('--mobile-context-region-height', `${context.getBoundingClientRect().height}px`)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(context)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const selected = bottomNavRef.current?.querySelector<HTMLElement>('[aria-current="page"]')
    if (selected?.getClientRects().length) selected.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeDestination])

  const sidebarToggleLabel = sidebarExpanded ? 'Collapse sidebar' : 'Expand sidebar'

  return <div className={`app-shell${sidebarExpanded ? '' : ' app-shell--sidebar-collapsed'}`}>
    <header className="desktop-brand-header"><Brand/></header>
    <aside className="rail">
      <nav aria-label="Primary navigation" className="menu-window">
        <p className="nav-section__label">Planning</p>
        <ul aria-label="Planning" className="nav-list">{MAIN_DESTINATIONS.map((item) => <li key={item.id}>{destinationButton(item)}</li>)}</ul>
        <div aria-label="Tracking" className="nav-tracking" role="group"><p className="nav-section__label">Tracking</p><ul className="nav-list">{TRACKING_DESTINATIONS.map((item) => <li key={item.id}>{destinationButton(item)}{item.id === 'progress' && <ProgressBoards sidebar/>}</li>)}</ul></div>
      </nav>
      <div className="rail__footer">
        <button className="nav-link rail__search" onClick={openSearch} type="button"><Icon name="search"/><span>Search</span><kbd aria-hidden="true">⌘/Ctrl K</kbd></button>
        <button aria-current={navigation.route.page.page === 'settings' ? 'page' : undefined} className="nav-link rail__data" onClick={onOpenData} type="button"><Icon name="settings"/><span>Data & settings</span></button>
        <div className="local-note"><strong>Your builds, your records</strong>Saved in this browser. Export a backup to keep a separate copy.</div>
        <button aria-expanded={sidebarExpanded} aria-label={sidebarToggleLabel} className="nav-link rail__toggle" onClick={() => setSidebarExpanded(expanded => !expanded)} title={sidebarToggleLabel} type="button"><Icon name="arrow-left"/></button>
      </div>
    </aside>
    <main className="main-shell" ref={mainRef}>
      <header className="mobile-header"><Brand/><div className="mobile-header__actions"><IconButton icon="search" label="Search planner" onClick={openSearch}/><IconButton icon="settings" label="Open data and settings" onClick={onOpenData}/></div></header>
      <header className={`context-bar${tracking ? '' : ' context-bar--planning'}${destination === 'map' ? ' context-bar--map' : ''}`} ref={contextRef}>
        {tracking ? <ContextSelectors busy={contextBusy} onSelectPlaythrough={onSelectPlaythrough} onSelectScenario={onSelectScenario} localData={localData}/> : <div className="context-bar__page" ref={setHeaderTarget}/>}
        <div className="context-bar__meta">
          {destination !== 'mods' && destination !== 'map' && destination !== 'save-editor' && <div aria-live="polite" className={`context-status context-status--${statusState}`} title={saveExplanation}><span className="context-status__dot"/>{saveLabel}</div>}
          <DevelopmentRefresh blocked={developmentRefreshBlocked} onRefresh={onDevelopmentRefresh}/>
        </div>
      </header>
      <WorkspaceHeaderContext value={headerSlots}><div className="content"><PreviewNotice/>{children}</div></WorkspaceHeaderContext>
    </main>
    <nav aria-label="Primary navigation" className="bottom-nav" ref={bottomNavRef}><div aria-label="Planning" className="bottom-nav__main" role="group">{MAIN_DESTINATIONS.map(destinationButton)}</div><div aria-label="Tracking" className="bottom-nav__tracking" role="group">{TRACKING_DESTINATIONS.map(destinationButton)}</div></nav>
    <UniversalSearch catalogs={catalogs} open={searchOpen}/>
  </div>
}

export function parseDestination() {
  return routeDestination(parseAppRoute(window.location.hash))
}
