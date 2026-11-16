import { ShareIdSchema, hostedSharePath } from '../../account/share-identity'
import { PUBLIC_SHARE_LIMITS, PUBLIC_SHARE_ROUTE_PREFIX, PUBLIC_SHARE_VERSION } from '../../interchange/public-share-schema'
import { type EntityRouteNameResolver, bundledEntityRouteName } from '../entity-route-names'
import { type AppRoute, type PageRoute, BUILDS_ROUTE } from './types.ts'
import { unresolved, parsePage, recoveryFor, formatPage } from './pages.ts'
import { parseOverlays, overlaysSupported, queryFromParams, appendQuery, hasOverlayQuery, formatOverlayPath } from './overlays.ts'
import { MAX_ROUTE_LENGTH, DEFAULT_PICKER_LIMIT } from './segments.ts'

export function parseAppRoute(hash: string): AppRoute {
  // Intake owns email secrets; generic route/error state must never retain their raw paths
  if (/^#\/account\/(verify|confirm-email)(?:\/|$)/.test(hash)) return { page: { page: 'settings', section: 'account' }, overlays: [], query: {} }
  const hosted = /^(?:#)?\/([bts])\/(.*)$/.exec(hash)
  if (hosted) {
    const id = ShareIdSchema.safeParse(hosted[2]!.split(/[?#]/, 1)[0])
    return { page: id.success ? { page: 'hosted-share', shareId: id.data, ...(hosted[1] === 'b' ? { kind: 'build' as const } : hosted[1] === 't' ? { kind: 'team' as const } : {}) } : unresolved(`/${hosted[1]}`, 'builds'), overlays: [], query: {} }
  }
  if (hash.startsWith('#/share/')) {
    if (!hash.startsWith(PUBLIC_SHARE_ROUTE_PREFIX) || hash.length > PUBLIC_SHARE_LIMITS.url) return { page: unresolved('/share', 'builds'), overlays: [], query: {} }
    const [rawPath, rawQuery = ''] = hash.slice(1).split('?', 2)
    const segments = rawPath.split('/').filter(Boolean)
    const encoded = segments[2] ?? ''
    const page: PageRoute = { page: 'share', encoded, version: PUBLIC_SHARE_VERSION }
    const params = new URLSearchParams(rawQuery)
    const overlays = parseOverlays(segments, 3, params)
    return /^[A-Za-z0-9_-]+$/.test(encoded) && overlays && overlaysSupported(page, overlays)
      ? { page, overlays, query: queryFromParams(params, overlays.length > 0) }
      : { page: unresolved('/share', 'builds'), overlays: [], query: {} }
  }
  if (!hash || hash === '#' || hash === '#/') return { ...BUILDS_ROUTE, legacy: true }
  const boundedHash = hash.length <= MAX_ROUTE_LENGTH ? hash : '#/invalid'
  const [rawPath, rawQuery = ''] = boundedHash.replace(/^#/, '').split('?', 2)
  const path = rawPath.replace(/^\/?/, '/')
  const segments = path.split('/').filter(Boolean)
  const params = new URLSearchParams(rawQuery)
  const parsed = parsePage(segments, path)
  if (parsed.page.page === 'unresolved') return { page: parsed.page, overlays: [], query: {} }
  const overlays = parseOverlays(segments, parsed.consumed, params)
  if (!overlays || !overlaysSupported(parsed.page, overlays)) return { page: unresolved(path, recoveryFor(segments)), overlays: [], query: {} }
  const query = queryFromParams(params, overlays.length > 0)
  if (parsed.page.page === 'settings' && parsed.page.section === 'game-setup' && query.scope?.[0] === 'playthrough') return { page: { page: 'settings', section: 'playthrough' }, overlays, query: {}, legacy: true }
  return { page: parsed.page, overlays, query, ...(parsed.legacy ? { legacy: true as const } : {}) }
}

export function formatAppRoute(route: AppRoute, resolveName: EntityRouteNameResolver = bundledEntityRouteName): string {
  if (route.page.page === 'hosted-share') return hostedSharePath(route.page.shareId, route.page.kind)
  const params = new URLSearchParams()
  appendQuery(params, route.query, route.overlays.length ? 'page.' : '')
  const queryOverlays = route.overlays.flatMap((overlay, index) => hasOverlayQuery(overlay) ? [{ overlay, index }] : [])
  const lastQueryOverlay = queryOverlays.at(-1)?.index
  for (const { overlay, index } of queryOverlays) {
    const queryKey = index === lastQueryOverlay ? 'q' : `${overlay.kind === 'search' ? 'search' : 'picker'}.${index}.q`
    if (overlay.query) params.set(queryKey, overlay.query)
    if (overlay.kind === 'definition-picker' && overlay.resultLimit !== DEFAULT_PICKER_LIMIT) params.set(index === lastQueryOverlay ? 'limit' : `picker.${index}.limit`, String(overlay.resultLimit))
  }
  const query = params.toString()
  return `#${formatPage(route.page, resolveName)}${formatOverlayPath(route.overlays, resolveName)}${query ? `?${query}` : ''}`
}

// App hashes win when leaving a clean share through an ordinary anchor; unrelated fragments are not routes
export function readBrowserRoute(): AppRoute {
  const { pathname, hash } = window.location
  return parseAppRoute(hash.startsWith('#/') ? hash : /^\/[bts]\//.test(pathname) ? pathname : hash)
}

export function browserRouteHref(route: AppRoute, resolveName: EntityRouteNameResolver = bundledEntityRouteName): string {
  const href = formatAppRoute(route, resolveName)
  // Clean share paths are root routes; a private hash route must not inherit a stale public pathname
  return href.startsWith('#') && /^\/[bts]\//.test(window.location.pathname) ? `/${href}` : href
}

export function isCurrentRouteHref(href: string): boolean {
  return new URL(href, window.location.href).href === window.location.href
}
