import { normalizeWeaponType, type WeaponType } from '../domain/skill-weapons'
import type { CatalogEntityKind } from '../domain/types'
import { decodeReferenceEntityKey, encodeReferenceEntityKey } from './search'
import { OPTIONAL_REFERENCE_AUDIENCES, REFERENCE_FACETS, type OptionalReferenceAudience, type ReferenceFacetFilters } from './reference-facets'
import { parseAppRoute, writeNavigationRoute, type AppRoute, type RouteQuery } from './navigation'

export const REFERENCE_ROUTE_STORAGE_KEY = 'crystal-companion:reference-route:v1'
export const REFERENCE_PAGE_SIZE = 100

const REFERENCE_ROUTE = '#/reference'
const ROUTE_VERSION = '1'
const MAX_QUERY_LENGTH = 500
const MAX_FACET_LENGTH = 256
const MAX_FACET_VALUES = 64
export const ROUTE_MAX_RESULT_LIMIT = 2_000
const KINDS = new Set<CatalogEntityKind>([
  'item',
  'class',
  'ability',
  'passive',
  'innate',
  'monsterMagic',
  'monster',
  'command',
  'status',
  'recipe',
  'location',
  'other',
])

export interface ReferenceRouteState extends ReferenceFacetFilters {
  readonly query: string
  readonly kinds: readonly CatalogEntityKind[]
  readonly categories: readonly string[]
  readonly sources: readonly string[]
  readonly audiences: readonly OptionalReferenceAudience[]
  readonly weapon?: WeaponType
  readonly includeUncertainSkills?: boolean
  readonly ppMin?: number
  readonly ppMax?: number
  readonly selectedKey?: string
  readonly resultLimit: number
}

export const DEFAULT_REFERENCE_ROUTE_STATE: ReferenceRouteState = Object.freeze({
  query: '',
  kinds: [],
  categories: [],
  sources: [],
  audiences: [],
  resultLimit: REFERENCE_PAGE_SIZE,
})

function queryString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  return value.normalize('NFKC').slice(0, maxLength)
}

function opaqueString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return undefined
  return value
}

function facetValues(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const values = value.flatMap((entry) => {
    const identifier = opaqueString(entry, MAX_FACET_LENGTH)
    return identifier ? [identifier] : []
  })
  return Array.from(new Set(values)).slice(0, MAX_FACET_VALUES)
}

function kindValues(value: unknown): readonly CatalogEntityKind[] {
  return facetValues(value).filter((entry): entry is CatalogEntityKind => KINDS.has(entry as CatalogEntityKind))
}

const REFERENCE_AUDIENCE_VALUES = new Set<OptionalReferenceAudience>(OPTIONAL_REFERENCE_AUDIENCES.map(audience => audience.value))

function audienceValues(value: unknown): readonly OptionalReferenceAudience[] {
  return facetValues(value).filter((entry): entry is OptionalReferenceAudience => REFERENCE_AUDIENCE_VALUES.has(entry as OptionalReferenceAudience))
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

function resultLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return REFERENCE_PAGE_SIZE
  return Math.min(ROUTE_MAX_RESULT_LIMIT, Math.max(REFERENCE_PAGE_SIZE, value))
}

function selectedKey(value: unknown): string | undefined {
  const candidate = opaqueString(value, 4_096)
  if (!candidate) return undefined
  const decoded = decodeReferenceEntityKey(candidate)
  return decoded ? encodeReferenceEntityKey(decoded) : undefined
}

export function normalizeReferenceRouteState(value: unknown): ReferenceRouteState {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    query: queryString(record.query, MAX_QUERY_LENGTH) ?? '',
    kinds: kindValues(record.kinds),
    categories: facetValues(record.categories),
    sources: facetValues(record.sources),
    audiences: audienceValues(record.audiences),
    ...Object.fromEntries(REFERENCE_FACETS.flatMap(facet => {
      const values = facetValues(record[facet.key])
      return values.length ? [[facet.key, values]] : []
    })),
    ...(normalizeWeaponType(record.weapon) && record.includeUncertainSkills === true ? { includeUncertainSkills: true } : {}),
    ...(normalizeWeaponType(record.weapon) ? { weapon: normalizeWeaponType(record.weapon) } : {}),
    ...(finiteNumber(record.ppMin) === undefined ? {} : { ppMin: finiteNumber(record.ppMin) }),
    ...(finiteNumber(record.ppMax) === undefined ? {} : { ppMax: finiteNumber(record.ppMax) }),
    ...(selectedKey(record.selectedKey) === undefined ? {} : { selectedKey: selectedKey(record.selectedKey) }),
    resultLimit: resultLimit(record.resultLimit),
  }
}

function parseStoredState(stored: string | null | undefined): ReferenceRouteState | undefined {
  if (!stored || stored.length > 32_768) return undefined
  try {
    return normalizeReferenceRouteState(JSON.parse(stored))
  } catch {
    return undefined
  }
}

function queryNumber(params: URLSearchParams, key: string): number | undefined {
  const value = params.get(key)
  if (value === null || value.trim() === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function paramsFromRouteQuery(query: RouteQuery): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, values] of Object.entries(query)) for (const value of values) params.append(key, value)
  return params
}

function routeQueryFromParams(params: URLSearchParams): RouteQuery {
  const query = Object.create(null) as Record<string, string[]>
  for (const [key, value] of params) (query[key] ??= []).push(value)
  return query
}

function referenceQuery(state: ReferenceRouteState): RouteQuery {
  const params = new URLSearchParams({ v: ROUTE_VERSION })
  if (state.query) params.set('q', state.query)
  for (const kind of state.kinds) params.append('kind', kind)
  for (const category of state.categories) params.append('category', category)
  for (const source of state.sources) params.append('source', source)
  for (const audience of state.audiences) params.append('audience', audience)
  for (const facet of REFERENCE_FACETS) for (const value of state[facet.key] ?? []) params.append(facet.parameter, value)
  if (state.weapon) params.set('weapon', state.weapon)
  if (state.includeUncertainSkills) params.set('uncertainSkills', '1')
  if (state.ppMin !== undefined) params.set('ppMin', String(state.ppMin))
  if (state.ppMax !== undefined) params.set('ppMax', String(state.ppMax))
  if (state.resultLimit !== REFERENCE_PAGE_SIZE) params.set('limit', String(state.resultLimit))
  return routeQueryFromParams(params)
}

export function parseReferenceRoute(hash: string, stored?: string | null): ReferenceRouteState {
  const route = parseAppRoute(hash)
  if (route.page.page !== 'reference') return DEFAULT_REFERENCE_ROUTE_STATE
  const params = paramsFromRouteQuery(route.query)
  if (params.size === 0 && route.page.view === 'list') return parseStoredState(stored) ?? DEFAULT_REFERENCE_ROUTE_STATE
  const routeSelected = route.page.view === 'detail' && route.page.ref.kind === 'catalog'
    ? encodeReferenceEntityKey({ catalogId: route.page.ref.catalogId, catalogRevisionId: route.page.ref.catalogRevisionId, entityId: route.page.ref.entityId })
    : undefined
  return normalizeReferenceRouteState({
    query: params.get('q') ?? '',
    kinds: params.getAll('kind'),
    categories: params.getAll('category'),
    sources: params.getAll('source'),
    audiences: params.getAll('audience'),
    ...Object.fromEntries(REFERENCE_FACETS.map(facet => [facet.key, params.getAll(facet.parameter)])),
    weapon: params.get('weapon'),
    includeUncertainSkills: params.get('uncertainSkills') === '1',
    ppMin: queryNumber(params, 'ppMin'),
    ppMax: queryNumber(params, 'ppMax'),
    selectedKey: routeSelected ?? params.get('selected') ?? undefined,
    resultLimit: queryNumber(params, 'limit') ?? REFERENCE_PAGE_SIZE,
  })
}

export function formatReferenceRoute(value: ReferenceRouteState): string {
  const state = normalizeReferenceRouteState(value)
  const params = new URLSearchParams({ v: ROUTE_VERSION })
  if (state.query) params.set('q', state.query)
  for (const kind of state.kinds) params.append('kind', kind)
  for (const category of state.categories) params.append('category', category)
  for (const source of state.sources) params.append('source', source)
  for (const audience of state.audiences) params.append('audience', audience)
  for (const facet of REFERENCE_FACETS) for (const entry of state[facet.key] ?? []) params.append(facet.parameter, entry)
  if (state.weapon) params.set('weapon', state.weapon)
  if (state.includeUncertainSkills) params.set('uncertainSkills', '1')
  if (state.ppMin !== undefined) params.set('ppMin', String(state.ppMin))
  if (state.ppMax !== undefined) params.set('ppMax', String(state.ppMax))
  if (state.selectedKey) params.set('selected', state.selectedKey)
  if (state.resultLimit !== REFERENCE_PAGE_SIZE) params.set('limit', String(state.resultLimit))
  return `${REFERENCE_ROUTE}?${params.toString()}`
}

export function readReferenceRouteState(): ReferenceRouteState {
  if (typeof window === 'undefined') return DEFAULT_REFERENCE_ROUTE_STATE
  let stored: string | null = null
  try {
    stored = window.sessionStorage.getItem(REFERENCE_ROUTE_STORAGE_KEY)
  } catch {
    // Browsers can disable session storage while history navigation remains usable
  }
  return parseReferenceRoute(window.location.hash, stored)
}

export function commitReferenceRouteState(value: ReferenceRouteState, mode: 'push' | 'replace' = 'replace'): ReferenceRouteState {
  const state = normalizeReferenceRouteState(value)
  if (typeof window === 'undefined') return state
  try {
    window.sessionStorage.setItem(REFERENCE_ROUTE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Route state remains in browser history when session storage is unavailable
  }
  const current = parseAppRoute(window.location.hash)
  const base: AppRoute = current.page.page === 'reference' ? current : { page: { page: 'reference', view: 'list' }, overlays: [], query: {} }
  writeNavigationRoute({ ...base, query: referenceQuery(state) }, mode)
  return state
}

export const INVENTORY_ROUTE_STORAGE_KEY = 'crystal-companion:inventory-route:v1'
export const INVENTORY_PAGE_SIZE = 100

const INVENTORY_ROUTE = '#/inventory'
const INVENTORY_FILTERS = new Set(['All', 'Owned', 'Unknown', 'Wishlist', 'Protected'])

export type InventoryRouteFilter = 'All' | 'Owned' | 'Unknown' | 'Wishlist' | 'Protected'

export interface InventoryRouteState {
  readonly query: string
  readonly filter: InventoryRouteFilter
  readonly categories: readonly string[]
  readonly sources: readonly string[]
  readonly resultLimit: number
}

export const DEFAULT_INVENTORY_ROUTE_STATE: InventoryRouteState = Object.freeze({
  query: '',
  filter: 'All',
  categories: [],
  sources: [],
  resultLimit: INVENTORY_PAGE_SIZE,
})

export function normalizeInventoryRouteState(value: unknown): InventoryRouteState {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const filter = typeof record.filter === 'string' && INVENTORY_FILTERS.has(record.filter) ? record.filter as InventoryRouteFilter : 'All'
  return {
    query: queryString(record.query, MAX_QUERY_LENGTH) ?? '',
    filter,
    categories: facetValues(record.categories),
    sources: facetValues(record.sources),
    resultLimit: resultLimit(record.resultLimit),
  }
}

export function parseInventoryRoute(hash: string, stored?: string | null): InventoryRouteState {
  const route = parseAppRoute(hash)
  if (route.page.page !== 'inventory') return DEFAULT_INVENTORY_ROUTE_STATE
  const params = paramsFromRouteQuery(route.query)
  if (params.size === 0) return parseStoredInventoryState(stored) ?? DEFAULT_INVENTORY_ROUTE_STATE
  return normalizeInventoryRouteState({
    query: params.get('q') ?? '',
    filter: params.get('filter') ?? 'All',
    categories: params.getAll('category'),
    sources: params.getAll('source'),
    resultLimit: queryNumber(params, 'limit') ?? INVENTORY_PAGE_SIZE,
  })
}

function parseStoredInventoryState(stored: string | null | undefined): InventoryRouteState | undefined {
  if (!stored || stored.length > 32_768) return undefined
  try {
    return normalizeInventoryRouteState(JSON.parse(stored))
  } catch {
    return undefined
  }
}

export function formatInventoryRoute(value: InventoryRouteState): string {
  const state = normalizeInventoryRouteState(value)
  const params = new URLSearchParams({ v: ROUTE_VERSION })
  if (state.query) params.set('q', state.query)
  if (state.filter !== 'All') params.set('filter', state.filter)
  for (const category of state.categories) params.append('category', category)
  for (const source of state.sources) params.append('source', source)
  if (state.resultLimit !== INVENTORY_PAGE_SIZE) params.set('limit', String(state.resultLimit))
  return `${INVENTORY_ROUTE}?${params.toString()}`
}

export function readInventoryRouteState(): InventoryRouteState {
  if (typeof window === 'undefined') return DEFAULT_INVENTORY_ROUTE_STATE
  let stored: string | null = null
  try {
    stored = window.sessionStorage.getItem(INVENTORY_ROUTE_STORAGE_KEY)
  } catch {
    // Browser history still carries inventory filters when session storage is unavailable
  }
  return parseInventoryRoute(window.location.hash, stored)
}

export function commitInventoryRouteState(value: InventoryRouteState, mode: 'push' | 'replace' = 'replace'): InventoryRouteState {
  const state = normalizeInventoryRouteState(value)
  if (typeof window === 'undefined') return state
  try {
    window.sessionStorage.setItem(INVENTORY_ROUTE_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Route state remains in browser history when session storage is unavailable
  }
  const params = new URLSearchParams({ v: ROUTE_VERSION })
  if (state.query) params.set('q', state.query)
  if (state.filter !== 'All') params.set('filter', state.filter)
  for (const category of state.categories) params.append('category', category)
  for (const source of state.sources) params.append('source', source)
  if (state.resultLimit !== INVENTORY_PAGE_SIZE) params.set('limit', String(state.resultLimit))
  const current = parseAppRoute(window.location.hash)
  const base: AppRoute = current.page.page === 'inventory' ? current : { page: { page: 'inventory', view: 'list' }, overlays: [], query: {} }
  writeNavigationRoute({ ...base, query: routeQueryFromParams(params) }, mode)
  return state
}
