import { MAX_SHARE_URL_LENGTH } from '../../interchange/share'
import { type EntityRouteNameResolver, bundledEntityRouteName } from '../entity-route-names'
import { type AppRoute, type PageRoute, BUILDS_ROUTE } from './types.ts'
import { unresolved, parsePage, recoveryFor, formatPage } from './pages.ts'
import { parseOverlays, overlaysSupported, queryFromParams, appendQuery, hasOverlayQuery, formatOverlayPath } from './overlays.ts'
import { MAX_ROUTE_LENGTH, DEFAULT_PICKER_LIMIT } from './segments.ts'

export function parseAppRoute(hash: string): AppRoute {
  if (hash.startsWith('#/share/')) {
    if (!/^#\/share\/v[123]\//.test(hash) || hash.length > MAX_SHARE_URL_LENGTH) return { page: unresolved('/share', 'builds'), overlays: [], query: {} }
    const [rawPath, rawQuery = ''] = hash.slice(1).split('?', 2)
    const segments = rawPath.split('/').filter(Boolean)
    const encoded = segments[2] ?? ''
    const page: PageRoute = { page: 'share', encoded }
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
