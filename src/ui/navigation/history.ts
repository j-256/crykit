import { type EntityRouteNameResolver, bundledEntityRouteName } from '../entity-route-names'
import { type AppRoute } from './types.ts'
import { parseAppRoute, formatAppRoute } from './routes.ts'

export const NAVIGATION_EVENT = 'crykit:navigation'

const NAVIGATION_STATE_KEY = 'crykitNavigation'

interface NavigationHistoryState {
  readonly index: number
  readonly parentHash?: string
  readonly returnHash?: string
  readonly returnIndex?: number
}

export function navigationState(value: unknown): NavigationHistoryState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = (value as Record<string, unknown>)[NAVIGATION_STATE_KEY]
  if (!candidate || typeof candidate !== 'object') return undefined
  const record = candidate as Record<string, unknown>
  return Number.isSafeInteger(record.index) ? {
    index: record.index as number,
    ...(typeof record.parentHash === 'string' ? { parentHash: record.parentHash } : {}),
    ...(typeof record.returnHash === 'string' ? { returnHash: record.returnHash } : {}),
    ...(Number.isSafeInteger(record.returnIndex) ? { returnIndex: record.returnIndex as number } : {}),
  } : undefined
}

export function withNavigationState(state: unknown, navigation: NavigationHistoryState) {
  // Other history consumers may store state here, so navigation owns only its namespaced field
  return state && typeof state === 'object' ? { ...state, [NAVIGATION_STATE_KEY]: navigation } : { [NAVIGATION_STATE_KEY]: navigation }
}

export function writeRouteHistory(next: AppRoute, replace: boolean, notify: boolean, resolveName: EntityRouteNameResolver = bundledEntityRouteName): number {
  const currentRoute = parseAppRoute(window.location.hash)
  const currentState = navigationState(window.history.state)
  const currentIndex = currentState?.index ?? 0
  const nextIndex = replace ? currentIndex : currentIndex + 1
  const enteringSettings = next.page.page === 'settings' && currentRoute.page.page !== 'settings'
  const remainingInSettings = next.page.page === 'settings' && currentRoute.page.page === 'settings'
  // Keep the entry route and index through settings detours so Close returns to the original page
  const state = withNavigationState(window.history.state, {
    index: nextIndex,
    ...(replace && currentState?.parentHash ? { parentHash: currentState.parentHash } : !replace ? { parentHash: formatAppRoute(currentRoute, resolveName) } : {}),
    ...(enteringSettings ? { returnHash: formatAppRoute(currentRoute, resolveName), returnIndex: currentIndex }
      : remainingInSettings && currentState?.returnHash && currentState.returnIndex !== undefined ? { returnHash: currentState.returnHash, returnIndex: currentState.returnIndex }
      : {}),
  })
  window.history[replace ? 'replaceState' : 'pushState'](state, '', formatAppRoute(next, resolveName))
  if (notify) notifyNavigationWrite()
  return nextIndex
}

export function writeNavigationRoute(route: AppRoute, mode: 'push' | 'replace' = 'replace'): void {
  if (typeof window !== 'undefined') writeRouteHistory(route, mode === 'replace', true)
}

export function notifyNavigationWrite(): void {
  // pushState/replaceState do not emit native traversal events; external writes must notify the controller
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NAVIGATION_EVENT))
}
