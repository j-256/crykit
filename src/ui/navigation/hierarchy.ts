import { type AppRoute, type Destination, PROGRESS_PAGES, BUILDS_ROUTE, type RouteOverlay, type RouteQuery } from './types.ts'
import { formatAppRoute } from './routes.ts'

export function routeDestination(route: AppRoute): Destination {
  if (route.page.page === 'share') return 'builds'
  if (route.page.page === 'settings') return 'builds'
  if (route.page.page === 'unresolved') return route.page.recovery
  return route.page.page
}

export function routeTitle(route: AppRoute): string {
  const top = route.overlays.at(-1)
  if (top?.kind === 'search') return 'Search | CryKit'
  if (top?.kind === 'definition-picker') return 'Choose definition | CryKit'
  if (top?.kind === 'definition-editor') return `${top.mode === 'new' ? 'Create' : 'Edit'} definition | CryKit`
  const page = route.page
  if (page.page === 'save-editor') return 'Save Editor | CryKit'
  if (page.page === 'map') return 'World Map | CryKit'
  if (page.page === 'mods') return `${page.view === 'editor' ? 'Mod editor' : 'Mods'} | CryKit`
  if (page.page === 'teams') return `${page.view === 'adopt' ? 'Adopt Team' : page.view === 'edit' ? 'Edit Team' : 'Teams'} | CryKit`
  if (page.page === 'share') return 'Shared snapshot | CryKit'
  if (page.page === 'unresolved') return 'Page unavailable | CryKit'
  if (page.page === 'settings') return `${page.section === 'data' ? 'Data' : page.section === 'game-setup' ? 'Game Setup' : page.section.charAt(0).toLocaleUpperCase() + page.section.slice(1)} settings | CryKit`
  if (page.page === 'inventory') return `${page.view === 'new' ? 'Add inventory item' : page.view === 'event-new' ? 'Record acquisition' : page.view === 'edit' ? 'Edit inventory item' : 'Inventory'} | CryKit`
  if (page.page === 'characters') return `${page.view === 'new' ? 'Add character' : page.view === 'snapshot-new' ? 'Capture character' : page.view === 'snapshot' ? 'Recorded snapshot' : page.view === 'snapshot-compare' || page.view === 'snapshot-pair' ? 'Compare snapshots' : page.view === 'skill-screenshots' ? 'Import skill screenshots' : page.view === 'class-new' ? 'Add class progress' : page.view === 'class-edit' ? 'Edit class progress' : page.view === 'learning-new' ? 'Add learned ability' : page.view === 'learning-edit' ? 'Edit learned ability' : page.view === 'character' ? 'Character' : 'Characters'} | CryKit`
  if (page.page === 'builds') return `${page.view === 'build-new' ? 'Create Build' : page.view === 'revision-new' ? 'New Build revision' : page.view === 'revision-edit' ? 'Edit Build revision' : page.view === 'record-current' ? 'Record current Build' : page.view === 'scenario-new' ? 'Create party plan' : page.view === 'scenario' ? 'Party plan' : page.view === 'compare' || page.view === 'compare-pair' ? 'Compare Builds' : page.view === 'teams' ? 'Party plans' : page.view === 'build' || page.view === 'revision' ? 'Build' : 'Builds'} | CryKit`
  if (page.page === 'progress') return `${page.view === 'new' ? 'Add progress' : page.view === 'edit' ? 'Edit progress' : page.view === 'unlocks' ? 'Travel & unlocks' : page.view === 'quintar' ? 'Quintar breeding' : page.view === 'summons' ? 'Summons' : 'Progress'} | CryKit`
  return `${page.view === 'detail' ? 'Reference definition' : page.view === 'promote' ? 'Collect definitions' : 'Reference'} | CryKit`
}

export function routeForDestination(destination: Destination): AppRoute {
  return {
    page: destination === 'inventory' ? { page: 'inventory', view: 'list' }
      : destination === 'characters' ? { page: 'characters', view: 'list' }
      : destination === 'teams' ? { page: 'teams', view: 'list' }
      : destination === 'builds' ? { page: 'builds', view: 'library' }
      : destination === 'progress' ? PROGRESS_PAGES[0].page
      : destination === 'mods' ? { page: 'mods', view: 'library' }
      : destination === 'map' ? { page: 'map' }
      : destination === 'save-editor' ? { page: 'save-editor' }
      : { page: 'reference', view: 'list' },
    overlays: [],
    query: {},
  }
}

export function parentRoute(route: AppRoute): AppRoute | undefined {
  if (route.overlays.length) return { ...route, overlays: route.overlays.slice(0, -1) }
  const page = route.page
  if (page.page === 'teams') return page.view === 'list' ? undefined : page.view === 'adopt' || page.view === 'edit' ? { ...route, page: { page: 'teams', view: 'team', teamId: page.teamId } } : { ...route, page: { page: 'teams', view: 'list' } }
  if (page.page === 'share') return BUILDS_ROUTE
  if (page.page === 'inventory' && page.view !== 'list') return { ...route, page: { page: 'inventory', view: 'list' } }
  if (page.page === 'characters') {
    if (page.view === 'new') return { ...route, page: { page: 'characters', view: 'list' } }
    if (page.view === 'snapshot' || page.view === 'snapshot-compare' || page.view === 'snapshot-pair') return { ...route, page: { page: 'characters', view: 'character', characterId: page.characterId, tab: 'history' } }
    if (page.view !== 'list' && page.view !== 'character') return { ...route, page: { page: 'characters', view: 'character', characterId: page.characterId, tab: 'current' } }
    if (page.view === 'character') return { ...route, page: { page: 'characters', view: 'list' } }
  }
  if (page.page === 'builds') {
    if (page.view === 'build-new') return { ...route, page: { page: 'builds', view: 'library' } }
    if (page.view === 'revision-new') return { ...route, page: { page: 'builds', view: 'build', buildId: page.buildId } }
    if (page.view === 'revision-edit' || page.view === 'record-current') return { ...route, page: { page: 'builds', view: 'revision', buildId: page.buildId, revisionId: page.revisionId } }
    if (page.view === 'revision') return { ...route, page: { page: 'builds', view: 'build', buildId: page.buildId } }
    if (page.view === 'build') return { ...route, page: { page: 'builds', view: 'library' } }
    if (page.view === 'scenario-new' || page.view === 'scenario') return { ...route, page: { page: 'builds', view: 'teams' } }
    if (page.view === 'compare-pair') return { ...route, page: { page: 'builds', view: 'compare' } }
  }
  if (page.page === 'progress' && page.view !== 'list') return { ...route, page: { page: 'progress', view: 'list' } }
  if (page.page === 'reference' && page.view !== 'list') return { ...route, page: { page: 'reference', view: 'list' } }
  if (page.page === 'settings') return BUILDS_ROUTE
  return undefined
}

export function isRouteWithin(route: AppRoute, scope: AppRoute, matchQuery = false): boolean {
  const routeHash = formatAppRoute(route)
  const scopeHash = formatAppRoute(scope)
  const routePath = routeHash.split('?', 1)[0]
  const scopePath = scopeHash.split('?', 1)[0]
  if (matchQuery && routeHash.slice(routePath.length) !== scopeHash.slice(scopePath.length)) return false
  return routePath === scopePath || routePath.startsWith(`${scopePath}/`)
}

export function isReferenceResearchRoute(route: AppRoute): boolean {
  return route.overlays.length === 0 && (route.page.page === 'map' || (route.page.page === 'reference' && (route.page.view === 'list' || route.page.view === 'detail')))
}

export function routeWithOverlay(route: AppRoute, overlay: RouteOverlay): AppRoute {
  return { ...route, overlays: [...route.overlays, overlay] }
}

export function routeWithoutOverlays(route: AppRoute): AppRoute {
  return route.overlays.length ? { ...route, overlays: [] } : route
}

export function replaceRouteQuery(route: AppRoute, query: RouteQuery): AppRoute {
  return { ...route, query }
}
