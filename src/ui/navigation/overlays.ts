import { type EntityRouteNameResolver } from '../entity-route-names'
import { type RouteQuery, type RouteOverlay, type PageRoute, type SearchOverlay, type DefinitionPickerOverlay } from './types.ts'
import { boundedOpaque, decodeSegment, DEFAULT_PICKER_LIMIT, encodeSegment } from './segments.ts'
import { parseEntityRefPath, formatEntityRefPath } from './entities.ts'

const MAX_QUERY_KEYS = 128

const MAX_QUERY_VALUES = 256

const MAX_QUERY_VALUE_LENGTH = 4_096

const MAX_OVERLAYS = 16

const MAX_PICKER_LIMIT = 2_000

function boundedQuery(params: URLSearchParams, overlayPresent: boolean): RouteQuery {
  // Overlay parameters occupy the unprefixed namespace; parent filters survive under page.*
  const entries = Object.create(null) as Record<string, string[]>
  let count = 0
  for (const [rawKey, rawValue] of params) {
    if (count >= MAX_QUERY_VALUES) break
    const key = overlayPresent && rawKey.startsWith('page.') ? rawKey.slice(5) : rawKey
    if (overlayPresent && !rawKey.startsWith('page.')) continue
    if (!boundedOpaque(key, 256) || rawValue.length > MAX_QUERY_VALUE_LENGTH) continue
    if (!Object.hasOwn(entries, key) && Object.keys(entries).length >= MAX_QUERY_KEYS) continue
    if (!Object.hasOwn(entries, key)) entries[key] = []
    entries[key]!.push(rawValue)
    count += 1
  }
  return entries
}

export function parseOverlays(segments: readonly string[], offset: number, params: URLSearchParams): readonly RouteOverlay[] | undefined {
  const overlays: RouteOverlay[] = []
  let cursor = offset
  while (cursor < segments.length) {
    if (overlays.length >= MAX_OVERLAYS) return undefined
    if (segments[cursor] === 'search') {
      overlays.push({ kind: 'search', query: '' })
      cursor += 1
      continue
    }
    if (segments[cursor] === 'pick') {
      let fieldKey: string | undefined
      if (segments[cursor + 1] === 'slot') {
        const slotId = decodeSegment(segments[cursor + 2] ?? '')
        if (slotId) { fieldKey = `slot:${slotId}`; cursor += 3 }
      } else {
        fieldKey = decodeSegment(segments[cursor + 1] ?? '')
        cursor += 2
      }
      if (!fieldKey) return undefined
      overlays.push({ kind: 'definition-picker', fieldKey, query: '', resultLimit: DEFAULT_PICKER_LIMIT })
      continue
    }
    if (segments[cursor] === 'definitions' && segments[cursor + 1] === 'new') {
      overlays.push({ kind: 'definition-editor', mode: 'new' })
      cursor += 2
      continue
    }
    if (segments[cursor] === 'definitions' && segments[cursor + 1] === 'override') {
      const parsed = parseEntityRefPath(segments, cursor + 2)
      if (!parsed || parsed.ref.kind !== 'personal') return undefined
      overlays.push({ kind: 'definition-editor', mode: 'override', ref: parsed.ref })
      cursor += 2 + parsed.consumed
      continue
    }
    return undefined
  }
  const queryOverlays = overlays.map((overlay, index) => ({ overlay, index })).filter(({ overlay }) => overlay.kind === 'search' || overlay.kind === 'definition-picker')
  // The top searchable layer uses q/limit while earlier layers keep their own indexed parameters
  const lastQueryOverlay = queryOverlays.at(-1)?.index
  return overlays.map((overlay, index) => {
    if (overlay.kind === 'search') return { ...overlay, query: (params.get(index === lastQueryOverlay ? 'q' : `search.${index}.q`) ?? '').normalize('NFKC').slice(0, 500) }
    if (overlay.kind !== 'definition-picker') return overlay
    const rawLimit = Number(params.get(index === lastQueryOverlay ? 'limit' : `picker.${index}.limit`))
    return {
      ...overlay,
      query: (params.get(index === lastQueryOverlay ? 'q' : `picker.${index}.q`) ?? '').normalize('NFKC').slice(0, 500),
      resultLimit: Number.isSafeInteger(rawLimit) ? Math.max(DEFAULT_PICKER_LIMIT, Math.min(MAX_PICKER_LIMIT, rawLimit)) : DEFAULT_PICKER_LIMIT,
    }
  })
}

function supportsDefinitionPicker(page: PageRoute, fieldKey: string): boolean {
  if (page.page === 'inventory') {
    if (page.view === 'new' || page.view === 'edit') return fieldKey === 'item-definition'
    return page.view === 'event-new' && fieldKey === 'event-item-reference'
  }
  if (page.page === 'characters') {
    if (page.view === 'snapshot-new' || page.view === 'character' && page.tab === 'current') return fieldKey === 'primary-class' || fieldKey === 'secondary-class' || fieldKey.startsWith('slot:')
    if (page.view === 'class-new') return fieldKey === 'class-reference'
    if (page.view === 'learning-new') return fieldKey === 'node-reference'
    return false
  }
  if (page.page === 'builds' && (page.view === 'build-new' || page.view === 'revision-new' || page.view === 'revision-edit')) {
    return fieldKey === 'primary-class' || fieldKey === 'secondary-class' || fieldKey === 'primaryClass' || fieldKey === 'secondaryClass' || fieldKey.startsWith('slot:')
  }
  return page.page === 'progress' && page.view === 'new' && fieldKey === 'class-reference'
}

export function overlaysSupported(page: PageRoute, overlays: readonly RouteOverlay[]): boolean {
  let cursor = 0
  const first = overlays[cursor]
  if (first?.kind === 'definition-picker') {
    if (!supportsDefinitionPicker(page, first.fieldKey)) return false
    cursor += 1
    if (overlays[cursor]?.kind === 'definition-editor') {
      if (page.page === 'builds') return false
      cursor += 1
    }
  } else if (first?.kind === 'definition-editor') {
    if (page.page !== 'reference' || page.view !== 'detail' || first.mode !== 'override') return false
    cursor += 1
  }
  if (overlays[cursor]?.kind === 'search') {
    cursor += 1
    const searchEditor = overlays[cursor]
    if (searchEditor?.kind === 'definition-editor' && searchEditor.mode === 'new') cursor += 1
  }
  return cursor === overlays.length
}

export function queryFromParams(params: URLSearchParams, overlayPresent: boolean): RouteQuery {
  return boundedQuery(params, overlayPresent)
}

export function formatOverlayPath(overlays: readonly RouteOverlay[], resolveName: EntityRouteNameResolver): string {
  return overlays.map((overlay) => {
    if (overlay.kind === 'search') return '/search'
    if (overlay.kind === 'definition-picker') return overlay.fieldKey.startsWith('slot:') ? `/pick/slot/${encodeSegment(overlay.fieldKey.slice(5))}` : `/pick/${encodeSegment(overlay.fieldKey)}`
    return overlay.mode === 'new' ? '/definitions/new' : `/definitions/override/${formatEntityRefPath(overlay.ref, resolveName)}`
  }).join('')
}

export function appendQuery(params: URLSearchParams, query: RouteQuery, prefix = '') {
  for (const [key, values] of Object.entries(query)) for (const value of values) params.append(`${prefix}${key}`, value)
}

export function hasOverlayQuery(overlay: RouteOverlay): overlay is SearchOverlay | DefinitionPickerOverlay {
  return overlay.kind === 'search' || overlay.kind === 'definition-picker'
}
