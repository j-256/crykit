import type { AppRoute, RouteQuery } from './navigation'

export type ModEditorView = 'document' | 'map' | 'dictionary'
export type ModWorkspaceView = 'library' | ModEditorView
export const MOD_WORKSPACE_PAGES = [
  { id: 'library', label: 'Mod Library' },
  { id: 'map', label: 'Map Editor' },
  { id: 'document', label: 'JSON Editor' },
  { id: 'dictionary', label: 'Enum Dictionary' },
] as const

export function modEditorView(query: RouteQuery): ModEditorView {
  return query.view?.[0] === 'map' ? 'map' : query.view?.[0] === 'dictionary' ? 'dictionary' : 'document'
}

export function modWorkspaceRoute(view: ModWorkspaceView, query: RouteQuery = {}): AppRoute {
  // Views share one inspector instance and draft queue; only the library leaves that workspace
  const { view: _view, ...sharedQuery } = query
  return { page: { page: 'mods', view: view === 'library' ? 'library' : 'editor' }, overlays: [], query: view === 'library' ? {} : { ...sharedQuery, ...(view === 'document' ? {} : { view: [view] }) } }
}

export function changesModDraftContext(from: AppRoute, to: AppRoute): boolean {
  if (from.page.page !== 'mods' || from.page.view !== 'editor' || to.page.page !== 'mods' || to.page.view !== 'editor') return false
  if (from.query.draft?.[0] !== to.query.draft?.[0]) return true
  const previous = modEditorView(from.query)
  const next = modEditorView(to.query)
  // Dictionary research keeps a pending JSON value mounted; map moves must be resolved before switching editors
  return previous !== next && (previous === 'map' || next === 'map')
}
