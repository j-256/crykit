import { hostedSharePath, type HostedShareKind } from '../../account/share-identity'
import { type EntityRouteNameResolver, bundledEntityRouteName } from '../entity-route-names'
import { type AppRoute } from './types.ts'
import { readBrowserRoute, formatAppRoute, browserRouteHref } from './routes.ts'

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
  // A beacon already running in this document can observe same-document path changes
  // Cross-document navigation keeps public locators out of its SPA measurements
  if (next.page.page === 'hosted-share' && hasPageAnalytics()) {
    window.location[replace ? 'replace' : 'assign'](formatAppRoute(next, resolveName))
    return navigationState(window.history.state)?.index ?? 0
  }
  const currentRoute = readBrowserRoute()
  const currentState = navigationState(window.history.state)
  const currentIndex = currentState?.index ?? 0
  const nextIndex = replace ? currentIndex : currentIndex + 1
  const enteringSettings = next.page.page === 'settings' && currentRoute.page.page !== 'settings'
  const remainingInSettings = next.page.page === 'settings' && currentRoute.page.page === 'settings'
  // Keep the entry route and index through settings detours so Back returns to the original page
  const state = withNavigationState(window.history.state, {
    index: nextIndex,
    ...(replace && currentState?.parentHash ? { parentHash: currentState.parentHash } : !replace ? { parentHash: formatAppRoute(currentRoute, resolveName) } : {}),
    ...(enteringSettings ? { returnHash: formatAppRoute(currentRoute, resolveName), returnIndex: currentIndex }
      : remainingInSettings && currentState?.returnHash && currentState.returnIndex !== undefined ? { returnHash: currentState.returnHash, returnIndex: currentState.returnIndex }
      : {}),
  })
  window.history[replace ? 'replaceState' : 'pushState'](state, '', browserRouteHref(next, resolveName))
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

export function canonicalizeHostedShare(shareId: string, kind: HostedShareKind): void {
  const current = readBrowserRoute()
  if (current.page.page !== 'hosted-share' || current.page.shareId !== shareId) return
  // Preserve the complete existing history entry, including other consumers and navigation return metadata
  const path = hostedSharePath(shareId, kind)
  if (hasPageAnalytics()) { window.location.replace(path); return }
  window.history.replaceState(window.history.state, '', path)
  notifyNavigationWrite()
}

function hasPageAnalytics(): boolean {
  // Presence also covers a module beacon scheduled but not yet evaluated
  return document.querySelector('script[data-cf-beacon], script[src^="https://static.cloudflareinsights.com/beacon.min.js"]') !== null
}
