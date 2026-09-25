import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react'
import { MAX_ID_LENGTH } from '../domain'
import type {
  BuildId,
  BuildRevisionId,
  CatalogId,
  CatalogRevisionId,
  CharacterId,
  CharacterSnapshotId,
  EntityId,
  EntityRef,
  InventoryPositionId,
  PersonalDefinitionId,
  ProgressRecordId,
  ScenarioId,
} from '../domain/types'

export type Destination = 'inventory' | 'characters' | 'builds' | 'progress' | 'reference'
export type CharacterTab = 'current' | 'classes' | 'knowledge' | 'magic' | 'history'
export type SettingsSection = 'data' | 'ruleset' | 'history' | 'storage'

export type InventoryPageRoute =
  | { readonly page: 'inventory'; readonly view: 'list' }
  | { readonly page: 'inventory'; readonly view: 'new' }
  | { readonly page: 'inventory'; readonly view: 'event-new' }
  | { readonly page: 'inventory'; readonly view: 'edit'; readonly positionId: InventoryPositionId }

export type CharactersPageRoute =
  | { readonly page: 'characters'; readonly view: 'list' }
  | { readonly page: 'characters'; readonly view: 'new' }
  | { readonly page: 'characters'; readonly view: 'character'; readonly characterId: CharacterId; readonly tab: CharacterTab }
  | { readonly page: 'characters'; readonly view: 'snapshot-new'; readonly characterId: CharacterId }
  | { readonly page: 'characters'; readonly view: 'snapshot'; readonly characterId: CharacterId; readonly snapshotId: CharacterSnapshotId }
  | { readonly page: 'characters'; readonly view: 'snapshot-compare'; readonly characterId: CharacterId }
  | { readonly page: 'characters'; readonly view: 'snapshot-pair'; readonly characterId: CharacterId; readonly leftSnapshotId: CharacterSnapshotId; readonly rightSnapshotId: CharacterSnapshotId }
  | { readonly page: 'characters'; readonly view: 'class-new'; readonly characterId: CharacterId }
  | { readonly page: 'characters'; readonly view: 'class-edit'; readonly characterId: CharacterId; readonly ref: EntityRef }
  | { readonly page: 'characters'; readonly view: 'learning-new'; readonly characterId: CharacterId; readonly learningKind: 'knowledge' | 'magic' }
  | { readonly page: 'characters'; readonly view: 'learning-edit'; readonly characterId: CharacterId; readonly learningKind: 'knowledge' | 'magic'; readonly ref: EntityRef }

export type BuildsPageRoute =
  | { readonly page: 'builds'; readonly view: 'library' }
  | { readonly page: 'builds'; readonly view: 'build-new' }
  | { readonly page: 'builds'; readonly view: 'build'; readonly buildId: BuildId }
  | { readonly page: 'builds'; readonly view: 'revision-new'; readonly buildId: BuildId }
  | { readonly page: 'builds'; readonly view: 'revision'; readonly buildId: BuildId; readonly revisionId: BuildRevisionId }
  | { readonly page: 'builds'; readonly view: 'revision-edit'; readonly buildId: BuildId; readonly revisionId: BuildRevisionId; readonly baseRevisionId?: BuildRevisionId }
  | { readonly page: 'builds'; readonly view: 'record-current'; readonly buildId: BuildId; readonly revisionId: BuildRevisionId }
  | { readonly page: 'builds'; readonly view: 'teams' }
  | { readonly page: 'builds'; readonly view: 'scenario-new' }
  | { readonly page: 'builds'; readonly view: 'scenario'; readonly scenarioId: ScenarioId }
  | { readonly page: 'builds'; readonly view: 'compare' }
  | { readonly page: 'builds'; readonly view: 'compare-pair'; readonly leftRevisionId: BuildRevisionId; readonly rightRevisionId: BuildRevisionId }

export type ProgressPageRoute =
  | { readonly page: 'progress'; readonly view: 'list' }
  | { readonly page: 'progress'; readonly view: 'new' }
  | { readonly page: 'progress'; readonly view: 'edit'; readonly recordId: ProgressRecordId }

export type ReferencePageRoute =
  | { readonly page: 'reference'; readonly view: 'list' }
  | { readonly page: 'reference'; readonly view: 'detail'; readonly ref: EntityRef }
  | { readonly page: 'reference'; readonly view: 'promote' }

export type SettingsPageRoute =
  | { readonly page: 'settings'; readonly section: SettingsSection }
  | { readonly page: 'settings'; readonly section: 'data'; readonly previewId: string }

export interface UnresolvedPageRoute {
  readonly page: 'unresolved'
  readonly requestedPath: string
  readonly reason: 'unknown-route' | 'malformed-identifier' | 'malformed-entity-reference'
  readonly recovery: Destination
}

export type PageRoute = InventoryPageRoute | CharactersPageRoute | BuildsPageRoute | ProgressPageRoute | ReferencePageRoute | SettingsPageRoute | UnresolvedPageRoute

export interface SearchOverlay {
  readonly kind: 'search'
  readonly query: string
}

export interface DefinitionPickerOverlay {
  readonly kind: 'definition-picker'
  readonly fieldKey: string
  readonly query: string
  readonly resultLimit: number
}

export type DefinitionEditorOverlay =
  | { readonly kind: 'definition-editor'; readonly mode: 'new' }
  | { readonly kind: 'definition-editor'; readonly mode: 'override'; readonly ref: EntityRef }

export type RouteOverlay = SearchOverlay | DefinitionPickerOverlay | DefinitionEditorOverlay
export type RouteQuery = Readonly<Record<string, readonly string[]>>

export interface AppRoute {
  readonly page: PageRoute
  readonly overlays: readonly RouteOverlay[]
  readonly query: RouteQuery
  readonly legacy?: true
}

export const INVENTORY_ROUTE: AppRoute = Object.freeze({ page: { page: 'inventory' as const, view: 'list' as const }, overlays: [], query: {} })
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/
const MAX_ROUTE_LENGTH = 16_384
const MAX_QUERY_KEYS = 128
const MAX_QUERY_VALUES = 256
const MAX_QUERY_VALUE_LENGTH = 4_096
const MAX_OVERLAYS = 16
const DEFAULT_PICKER_LIMIT = 100
const MAX_PICKER_LIMIT = 2_000
const NAVIGATION_EVENT = 'crystal-companion:navigation'
const NAVIGATION_STATE_KEY = 'crystalCompanionNavigation'
const COLLECTION_ID_RESERVED_SEGMENTS = new Set(['new', 'search', 'pick', 'definitions'])
const REVISION_ID_RESERVED_SEGMENTS = new Set(['new'])
const COMPARE_LEFT_ID_RESERVED_SEGMENTS = new Set(['search', 'pick', 'definitions'])

interface NavigationHistoryState {
  readonly index: number
  readonly parentHash?: string
  readonly returnHash?: string
  readonly returnIndex?: number
}

function boundedOpaque(value: unknown, maxLength = MAX_ID_LENGTH): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !CONTROL_CHARACTER.test(value) ? value : undefined
}

function decodeSegment(value: string): string | undefined {
  try {
    return boundedOpaque(decodeURIComponent(value))
  } catch {
    return undefined
  }
}

function encodeSegment(value: string): string {
  const bounded = boundedOpaque(value)
  if (!bounded) throw new Error('Route identifier is invalid')
  return encodeURIComponent(bounded)
}

function encodeIdentitySegment(value: string, reserved: ReadonlySet<string>): string {
  const encoded = encodeSegment(value)
  if (!reserved.has(value)) return encoded
  const firstByte = value.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()
  return `%${firstByte}${encodeURIComponent(value.slice(1))}`
}

export function formatEntityRefPath(ref: EntityRef): string {
  if (ref.kind === 'personal') return `personal/${encodeSegment(ref.definitionId)}`
  return `catalog/${encodeSegment(ref.catalogId)}/revisions/${encodeSegment(ref.catalogRevisionId)}/entities/${encodeSegment(ref.entityId)}`
}

export function parseEntityRefPath(segments: readonly string[], offset = 0): { readonly ref: EntityRef; readonly consumed: number } | undefined {
  if (segments[offset] === 'personal') {
    const definitionId = decodeSegment(segments[offset + 1] ?? '')
    return definitionId ? { ref: { kind: 'personal', definitionId: definitionId as PersonalDefinitionId }, consumed: 2 } : undefined
  }
  if (segments[offset] !== 'catalog' || segments[offset + 2] !== 'revisions' || segments[offset + 4] !== 'entities') return undefined
  const catalogId = decodeSegment(segments[offset + 1] ?? '')
  const catalogRevisionId = decodeSegment(segments[offset + 3] ?? '')
  const entityId = decodeSegment(segments[offset + 5] ?? '')
  return catalogId && catalogRevisionId && entityId
    ? { ref: { kind: 'catalog', catalogId: catalogId as CatalogId, catalogRevisionId: catalogRevisionId as CatalogRevisionId, entityId: entityId as EntityId }, consumed: 6 }
    : undefined
}

function unresolved(requestedPath: string, recovery: Destination, reason: UnresolvedPageRoute['reason'] = 'unknown-route'): PageRoute {
  return { page: 'unresolved', requestedPath: requestedPath.slice(0, MAX_ROUTE_LENGTH), reason, recovery }
}

function recoveryFor(segments: readonly string[]): Destination {
  const root = segments[0]
  return root === 'characters' || root === 'builds' || root === 'progress' || root === 'reference' ? root : 'inventory'
}

function overlayStartsAt(segments: readonly string[], index: number): boolean {
  const segment = segments[index]
  return segment === undefined || segment === 'search' || segment === 'pick' || segment === 'definitions'
}

function parsePage(segments: readonly string[], requestedPath: string): { readonly page: PageRoute; readonly consumed: number } {
  const bad = (recovery = recoveryFor(segments), reason?: UnresolvedPageRoute['reason']) => ({ page: unresolved(requestedPath, recovery, reason), consumed: segments.length })
  if (segments[0] === 'inventory') {
    if (overlayStartsAt(segments, 1)) return { page: { page: 'inventory', view: 'list' }, consumed: 1 }
    if (segments[1] === 'new') return { page: { page: 'inventory', view: 'new' }, consumed: 2 }
    if (segments[1] === 'events' && segments[2] === 'new') return { page: { page: 'inventory', view: 'event-new' }, consumed: 3 }
    if (segments[1] === 'items' && segments[3] === 'edit') {
      const positionId = decodeSegment(segments[2] ?? '')
      return positionId ? { page: { page: 'inventory', view: 'edit', positionId: positionId as InventoryPositionId }, consumed: 4 } : bad('inventory', 'malformed-identifier')
    }
    return bad('inventory')
  }
  if (segments[0] === 'characters') {
    if (overlayStartsAt(segments, 1)) return { page: { page: 'characters', view: 'list' }, consumed: 1 }
    if (segments[1] === 'new') return { page: { page: 'characters', view: 'new' }, consumed: 2 }
    const characterId = decodeSegment(segments[1] ?? '')
    if (!characterId) return bad('characters', 'malformed-identifier')
    const tab = segments[2]
    if (tab === 'current' || tab === 'classes' || tab === 'knowledge' || tab === 'magic' || tab === 'history') {
      if (overlayStartsAt(segments, 3)) return { page: { page: 'characters', view: 'character', characterId: characterId as CharacterId, tab }, consumed: 3 }
      if (tab === 'current' && segments[3] === 'snapshots' && segments[4] === 'new') return { page: { page: 'characters', view: 'snapshot-new', characterId: characterId as CharacterId }, consumed: 5 }
      if (tab === 'history' && segments[3] === 'snapshots') {
        const snapshotId = decodeSegment(segments[4] ?? '')
        return snapshotId ? { page: { page: 'characters', view: 'snapshot', characterId: characterId as CharacterId, snapshotId: snapshotId as CharacterSnapshotId }, consumed: 5 } : bad('characters', 'malformed-identifier')
      }
      if (tab === 'history' && segments[3] === 'compare') {
        if (overlayStartsAt(segments, 4)) return { page: { page: 'characters', view: 'snapshot-compare', characterId: characterId as CharacterId }, consumed: 4 }
        const leftSnapshotId = decodeSegment(segments[4] ?? '')
        const rightSnapshotId = decodeSegment(segments[5] ?? '')
        return leftSnapshotId && rightSnapshotId ? { page: { page: 'characters', view: 'snapshot-pair', characterId: characterId as CharacterId, leftSnapshotId: leftSnapshotId as CharacterSnapshotId, rightSnapshotId: rightSnapshotId as CharacterSnapshotId }, consumed: 6 } : bad('characters', 'malformed-identifier')
      }
      if (tab === 'classes' && segments[3] === 'new') return { page: { page: 'characters', view: 'class-new', characterId: characterId as CharacterId }, consumed: 4 }
      if (tab === 'classes') {
        const parsed = parseEntityRefPath(segments, 3)
        if (parsed && segments[3 + parsed.consumed] === 'edit') return { page: { page: 'characters', view: 'class-edit', characterId: characterId as CharacterId, ref: parsed.ref }, consumed: 4 + parsed.consumed }
      }
      if ((tab === 'knowledge' || tab === 'magic') && segments[3] === 'new') return { page: { page: 'characters', view: 'learning-new', characterId: characterId as CharacterId, learningKind: tab }, consumed: 4 }
      if (tab === 'knowledge' || tab === 'magic') {
        const parsed = parseEntityRefPath(segments, 3)
        if (parsed && segments[3 + parsed.consumed] === 'edit') return { page: { page: 'characters', view: 'learning-edit', characterId: characterId as CharacterId, learningKind: tab, ref: parsed.ref }, consumed: 4 + parsed.consumed }
      }
    }
    return bad('characters', segments.some((segment) => segment === 'catalog' || segment === 'personal') ? 'malformed-entity-reference' : 'unknown-route')
  }
  if (segments[0] === 'builds') {
    if (segments[1] === undefined || segments[1] === 'library' && overlayStartsAt(segments, 2)) return { page: { page: 'builds', view: 'library' }, consumed: segments[1] ? 2 : 1 }
    if (segments[1] === 'library') {
      if (segments[2] === 'new') return { page: { page: 'builds', view: 'build-new' }, consumed: 3 }
      const buildId = decodeSegment(segments[2] ?? '')
      if (!buildId) return bad('builds', 'malformed-identifier')
      if (overlayStartsAt(segments, 3)) return { page: { page: 'builds', view: 'build', buildId: buildId as BuildId }, consumed: 3 }
      if (segments[3] === 'revisions') {
        if (segments[4] === 'new' && overlayStartsAt(segments, 5)) return { page: { page: 'builds', view: 'revision-new', buildId: buildId as BuildId }, consumed: 5 }
        const revisionId = decodeSegment(segments[4] ?? '')
        if (!revisionId) return bad('builds', 'malformed-identifier')
        if (overlayStartsAt(segments, 5)) return { page: { page: 'builds', view: 'revision', buildId: buildId as BuildId, revisionId: revisionId as BuildRevisionId }, consumed: 5 }
        if (segments[5] === 'record-current') return { page: { page: 'builds', view: 'record-current', buildId: buildId as BuildId, revisionId: revisionId as BuildRevisionId }, consumed: 6 }
        if (segments[5] === 'edit') {
          if (segments[6] === 'from') {
            const baseRevisionId = decodeSegment(segments[7] ?? '')
            return baseRevisionId ? { page: { page: 'builds', view: 'revision-edit', buildId: buildId as BuildId, revisionId: revisionId as BuildRevisionId, baseRevisionId: baseRevisionId as BuildRevisionId }, consumed: 8 } : bad('builds', 'malformed-identifier')
          }
          return { page: { page: 'builds', view: 'revision-edit', buildId: buildId as BuildId, revisionId: revisionId as BuildRevisionId }, consumed: 6 }
        }
      }
      return bad('builds')
    }
    if (segments[1] === 'teams') {
      if (overlayStartsAt(segments, 2)) return { page: { page: 'builds', view: 'teams' }, consumed: 2 }
      if (segments[2] === 'new') return { page: { page: 'builds', view: 'scenario-new' }, consumed: 3 }
      const scenarioId = decodeSegment(segments[2] ?? '')
      return scenarioId ? { page: { page: 'builds', view: 'scenario', scenarioId: scenarioId as ScenarioId }, consumed: 3 } : bad('builds', 'malformed-identifier')
    }
    if (segments[1] === 'compare') {
      if (overlayStartsAt(segments, 2)) return { page: { page: 'builds', view: 'compare' }, consumed: 2 }
      const leftRevisionId = decodeSegment(segments[2] ?? '')
      const rightRevisionId = decodeSegment(segments[3] ?? '')
      return leftRevisionId && rightRevisionId ? { page: { page: 'builds', view: 'compare-pair', leftRevisionId: leftRevisionId as BuildRevisionId, rightRevisionId: rightRevisionId as BuildRevisionId }, consumed: 4 } : bad('builds', 'malformed-identifier')
    }
    return bad('builds')
  }
  if (segments[0] === 'progress') {
    if (overlayStartsAt(segments, 1)) return { page: { page: 'progress', view: 'list' }, consumed: 1 }
    if (segments[1] === 'new') return { page: { page: 'progress', view: 'new' }, consumed: 2 }
    const recordId = decodeSegment(segments[1] ?? '')
    return recordId && segments[2] === 'edit' ? { page: { page: 'progress', view: 'edit', recordId: recordId as ProgressRecordId }, consumed: 3 } : bad('progress', 'malformed-identifier')
  }
  if (segments[0] === 'reference') {
    if (overlayStartsAt(segments, 1)) return { page: { page: 'reference', view: 'list' }, consumed: 1 }
    if (segments[1] === 'promote') return { page: { page: 'reference', view: 'promote' }, consumed: 2 }
    const parsed = parseEntityRefPath(segments, 1)
    return parsed ? { page: { page: 'reference', view: 'detail', ref: parsed.ref }, consumed: 1 + parsed.consumed } : bad('reference', 'malformed-entity-reference')
  }
  if (segments[0] === 'settings') {
    const section = segments[1]
    if (section !== 'data' && section !== 'ruleset' && section !== 'history' && section !== 'storage') return bad('inventory')
    if (section === 'data' && segments[2] === 'import') {
      const previewId = decodeSegment(segments[3] ?? '')
      return previewId ? { page: { page: 'settings', section, previewId }, consumed: 4 } : bad('inventory', 'malformed-identifier')
    }
    return overlayStartsAt(segments, 2) ? { page: { page: 'settings', section }, consumed: 2 } : bad('inventory')
  }
  return bad()
}

function boundedQuery(params: URLSearchParams, overlayPresent: boolean): RouteQuery {
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

function parseOverlays(segments: readonly string[], offset: number, params: URLSearchParams): readonly RouteOverlay[] | undefined {
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
      if (!parsed) return undefined
      overlays.push({ kind: 'definition-editor', mode: 'override', ref: parsed.ref })
      cursor += 2 + parsed.consumed
      continue
    }
    return undefined
  }
  const queryOverlays = overlays.map((overlay, index) => ({ overlay, index })).filter(({ overlay }) => overlay.kind === 'search' || overlay.kind === 'definition-picker')
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
    if (page.view === 'snapshot-new') return fieldKey === 'primary-class' || fieldKey === 'secondary-class' || fieldKey.startsWith('slot:')
    if (page.view === 'class-new') return fieldKey === 'class-reference'
    if (page.view === 'learning-new') return fieldKey === 'node-reference'
    return false
  }
  if (page.page === 'builds' && (page.view === 'revision-new' || page.view === 'revision-edit')) {
    return fieldKey === 'primary-class' || fieldKey === 'secondary-class' || fieldKey === 'primaryClass' || fieldKey === 'secondaryClass' || fieldKey.startsWith('slot:')
  }
  return page.page === 'progress' && page.view === 'new' && fieldKey === 'class-reference'
}

function overlaysSupported(page: PageRoute, overlays: readonly RouteOverlay[]): boolean {
  let cursor = 0
  const first = overlays[cursor]
  if (first?.kind === 'definition-picker') {
    if (!supportsDefinitionPicker(page, first.fieldKey)) return false
    cursor += 1
    if (overlays[cursor]?.kind === 'definition-editor') cursor += 1
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

function queryFromParams(params: URLSearchParams, overlayPresent: boolean): RouteQuery {
  return boundedQuery(params, overlayPresent)
}

function legacyEntityRef(value: unknown): EntityRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'personal') {
    const definitionId = boundedOpaque(record.definitionId)
    return definitionId ? { kind: 'personal', definitionId: definitionId as PersonalDefinitionId } : undefined
  }
  if (record.kind !== 'catalog') return undefined
  const catalogId = boundedOpaque(record.catalogId)
  const catalogRevisionId = boundedOpaque(record.catalogRevisionId)
  const entityId = boundedOpaque(record.entityId)
  return catalogId && catalogRevisionId && entityId ? { kind: 'catalog', catalogId: catalogId as CatalogId, catalogRevisionId: catalogRevisionId as CatalogRevisionId, entityId: entityId as EntityId } : undefined
}

function legacyTargetPage(value: string): PageRoute | undefined {
  try {
    const record = JSON.parse(value) as Record<string, unknown>
    if (record.kind === 'definition') {
      const ref = legacyEntityRef(record.ref)
      return ref ? { page: 'reference', view: 'detail', ref } : undefined
    }
    const id = record.kind === 'inventory' ? boundedOpaque(record.positionId)
      : record.kind === 'character' ? boundedOpaque(record.characterId)
      : record.kind === 'build' ? boundedOpaque(record.buildId)
      : record.kind === 'scenario' ? boundedOpaque(record.scenarioId)
      : record.kind === 'progress' ? boundedOpaque(record.recordId)
      : undefined
    if (!id) return undefined
    if (record.kind === 'inventory') return { page: 'inventory', view: 'edit', positionId: id as InventoryPositionId }
    if (record.kind === 'character') return { page: 'characters', view: 'character', characterId: id as CharacterId, tab: 'current' }
    if (record.kind === 'build') return { page: 'builds', view: 'build', buildId: id as BuildId }
    if (record.kind === 'scenario') return { page: 'builds', view: 'scenario', scenarioId: id as ScenarioId }
    if (record.kind === 'progress') return { page: 'progress', view: 'edit', recordId: id as ProgressRecordId }
  } catch {
    return undefined
  }
  return undefined
}

function legacySelectedPage(value: string): ReferencePageRoute | undefined {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined
    const [catalogId, catalogRevisionId, entityId] = parsed.map((entry) => boundedOpaque(entry))
    return catalogId && catalogRevisionId && entityId ? { page: 'reference', view: 'detail', ref: { kind: 'catalog', catalogId: catalogId as CatalogId, catalogRevisionId: catalogRevisionId as CatalogRevisionId, entityId: entityId as EntityId } } : undefined
  } catch {
    return undefined
  }
}

export function parseAppRoute(hash: string): AppRoute {
  if (!hash || hash === '#') return { ...INVENTORY_ROUTE, legacy: true }
  const boundedHash = hash.length <= MAX_ROUTE_LENGTH ? hash : '#/invalid'
  const [rawPath, rawQuery = ''] = boundedHash.replace(/^#/, '').split('?', 2)
  const path = rawPath.replace(/^\/?/, '/')
  const segments = path.split('/').filter(Boolean)
  const params = new URLSearchParams(rawQuery)
  const legacyTarget = params.get('target')
  const legacyPage = legacyTarget ? legacyTargetPage(legacyTarget) : undefined
  if (legacyPage) return { page: legacyPage, overlays: [], query: {}, legacy: true }
  const parsed = parsePage(segments, path)
  if (parsed.page.page === 'reference' && parsed.page.view === 'list') {
    const selected = params.get('selected')
    const selectedPage = selected ? legacySelectedPage(selected) : undefined
    if (selectedPage) {
      params.delete('selected')
      return { page: selectedPage, overlays: [], query: queryFromParams(params, false), legacy: true }
    }
  }
  if (parsed.page.page === 'unresolved') return { page: parsed.page, overlays: [], query: {} }
  const overlays = parseOverlays(segments, parsed.consumed, params)
  if (!overlays || !overlaysSupported(parsed.page, overlays)) return { page: unresolved(path, recoveryFor(segments)), overlays: [], query: {} }
  return { page: parsed.page, overlays, query: queryFromParams(params, overlays.length > 0) }
}

function formatPage(page: PageRoute): string {
  if (page.page === 'inventory') {
    if (page.view === 'new') return '/inventory/new'
    if (page.view === 'event-new') return '/inventory/events/new'
    if (page.view === 'edit') return `/inventory/items/${encodeSegment(page.positionId)}/edit`
    return '/inventory'
  }
  if (page.page === 'characters') {
    if (page.view === 'new') return '/characters/new'
    if (page.view === 'list') return '/characters'
    const root = `/characters/${encodeIdentitySegment(page.characterId, COLLECTION_ID_RESERVED_SEGMENTS)}`
    if (page.view === 'snapshot-new') return `${root}/current/snapshots/new`
    if (page.view === 'snapshot') return `${root}/history/snapshots/${encodeSegment(page.snapshotId)}`
    if (page.view === 'snapshot-compare') return `${root}/history/compare`
    if (page.view === 'snapshot-pair') return `${root}/history/compare/${encodeIdentitySegment(page.leftSnapshotId, COMPARE_LEFT_ID_RESERVED_SEGMENTS)}/${encodeSegment(page.rightSnapshotId)}`
    if (page.view === 'class-new') return `${root}/classes/new`
    if (page.view === 'class-edit') return `${root}/classes/${formatEntityRefPath(page.ref)}/edit`
    if (page.view === 'learning-new') return `${root}/${page.learningKind}/new`
    if (page.view === 'learning-edit') return `${root}/${page.learningKind}/${formatEntityRefPath(page.ref)}/edit`
    return `${root}/${page.tab}`
  }
  if (page.page === 'builds') {
    if (page.view === 'library') return '/builds/library'
    if (page.view === 'build-new') return '/builds/library/new'
    if (page.view === 'build') return `/builds/library/${encodeIdentitySegment(page.buildId, COLLECTION_ID_RESERVED_SEGMENTS)}`
    if (page.view === 'revision-new') return `/builds/library/${encodeIdentitySegment(page.buildId, COLLECTION_ID_RESERVED_SEGMENTS)}/revisions/new`
    if (page.view === 'revision') return `/builds/library/${encodeIdentitySegment(page.buildId, COLLECTION_ID_RESERVED_SEGMENTS)}/revisions/${encodeIdentitySegment(page.revisionId, REVISION_ID_RESERVED_SEGMENTS)}`
    if (page.view === 'revision-edit') return `/builds/library/${encodeIdentitySegment(page.buildId, COLLECTION_ID_RESERVED_SEGMENTS)}/revisions/${encodeIdentitySegment(page.revisionId, REVISION_ID_RESERVED_SEGMENTS)}/edit${page.baseRevisionId ? `/from/${encodeSegment(page.baseRevisionId)}` : ''}`
    if (page.view === 'record-current') return `/builds/library/${encodeIdentitySegment(page.buildId, COLLECTION_ID_RESERVED_SEGMENTS)}/revisions/${encodeIdentitySegment(page.revisionId, REVISION_ID_RESERVED_SEGMENTS)}/record-current`
    if (page.view === 'teams') return '/builds/teams'
    if (page.view === 'scenario-new') return '/builds/teams/new'
    if (page.view === 'scenario') return `/builds/teams/${encodeIdentitySegment(page.scenarioId, COLLECTION_ID_RESERVED_SEGMENTS)}`
    if (page.view === 'compare-pair') return `/builds/compare/${encodeIdentitySegment(page.leftRevisionId, COMPARE_LEFT_ID_RESERVED_SEGMENTS)}/${encodeSegment(page.rightRevisionId)}`
    return '/builds/compare'
  }
  if (page.page === 'progress') {
    if (page.view === 'new') return '/progress/new'
    if (page.view === 'edit') return `/progress/${encodeIdentitySegment(page.recordId, COLLECTION_ID_RESERVED_SEGMENTS)}/edit`
    return '/progress'
  }
  if (page.page === 'reference') {
    if (page.view === 'promote') return '/reference/promote'
    if (page.view === 'detail') return `/reference/${formatEntityRefPath(page.ref)}`
    return '/reference'
  }
  if (page.page === 'settings') return `/settings/${page.section}${'previewId' in page ? `/import/${encodeSegment(page.previewId)}` : ''}`
  return page.requestedPath.startsWith('/') ? page.requestedPath : '/inventory'
}

function formatOverlayPath(overlays: readonly RouteOverlay[]): string {
  return overlays.map((overlay) => {
    if (overlay.kind === 'search') return '/search'
    if (overlay.kind === 'definition-picker') return overlay.fieldKey.startsWith('slot:') ? `/pick/slot/${encodeSegment(overlay.fieldKey.slice(5))}` : `/pick/${encodeSegment(overlay.fieldKey)}`
    return overlay.mode === 'new' ? '/definitions/new' : `/definitions/override/${formatEntityRefPath(overlay.ref)}`
  }).join('')
}

function appendQuery(params: URLSearchParams, query: RouteQuery, prefix = '') {
  for (const [key, values] of Object.entries(query)) for (const value of values) params.append(`${prefix}${key}`, value)
}

function hasOverlayQuery(overlay: RouteOverlay): overlay is SearchOverlay | DefinitionPickerOverlay {
  return overlay.kind === 'search' || overlay.kind === 'definition-picker'
}

export function formatAppRoute(route: AppRoute): string {
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
  return `#${formatPage(route.page)}${formatOverlayPath(route.overlays)}${query ? `?${query}` : ''}`
}

export function routeDestination(route: AppRoute): Destination {
  if (route.page.page === 'settings') return 'inventory'
  if (route.page.page === 'unresolved') return route.page.recovery
  return route.page.page
}

export function routeTitle(route: AppRoute): string {
  const top = route.overlays.at(-1)
  if (top?.kind === 'search') return 'Search | Crystal Companion'
  if (top?.kind === 'definition-picker') return 'Choose definition | Crystal Companion'
  if (top?.kind === 'definition-editor') return `${top.mode === 'new' ? 'Create' : 'Edit'} definition | Crystal Companion`
  const page = route.page
  if (page.page === 'unresolved') return 'Page unavailable | Crystal Companion'
  if (page.page === 'settings') return `${page.section === 'data' ? 'Data' : page.section.charAt(0).toLocaleUpperCase() + page.section.slice(1)} settings | Crystal Companion`
  if (page.page === 'inventory') return `${page.view === 'new' ? 'Add inventory item' : page.view === 'event-new' ? 'Record acquisition' : page.view === 'edit' ? 'Edit inventory item' : 'Inventory'} | Crystal Companion`
  if (page.page === 'characters') return `${page.view === 'new' ? 'Add character' : page.view === 'snapshot-new' ? 'Capture character' : page.view === 'snapshot' ? 'Recorded snapshot' : page.view === 'snapshot-compare' || page.view === 'snapshot-pair' ? 'Compare snapshots' : page.view === 'class-new' ? 'Add class progress' : page.view === 'class-edit' ? 'Edit class progress' : page.view === 'learning-new' ? 'Add learned ability' : page.view === 'learning-edit' ? 'Edit learned ability' : page.view === 'character' ? 'Character' : 'Characters'} | Crystal Companion`
  if (page.page === 'builds') return `${page.view === 'build-new' ? 'Create build' : page.view === 'revision-new' ? 'New build revision' : page.view === 'revision-edit' ? 'Edit build revision' : page.view === 'record-current' ? 'Record current build' : page.view === 'scenario-new' ? 'Create team scenario' : page.view === 'scenario' ? 'Team scenario' : page.view === 'compare' || page.view === 'compare-pair' ? 'Compare builds' : page.view === 'teams' ? 'Teams' : page.view === 'build' || page.view === 'revision' ? 'Build' : 'Builds'} | Crystal Companion`
  if (page.page === 'progress') return `${page.view === 'new' ? 'Add progress' : page.view === 'edit' ? 'Edit progress' : 'Progress'} | Crystal Companion`
  return `${page.view === 'detail' ? 'Reference definition' : page.view === 'promote' ? 'Collect definitions' : 'Reference'} | Crystal Companion`
}

export function routeForDestination(destination: Destination): AppRoute {
  return {
    page: destination === 'inventory' ? { page: 'inventory', view: 'list' }
      : destination === 'characters' ? { page: 'characters', view: 'list' }
      : destination === 'builds' ? { page: 'builds', view: 'library' }
      : destination === 'progress' ? { page: 'progress', view: 'list' }
      : { page: 'reference', view: 'list' },
    overlays: [],
    query: {},
  }
}

export function parentRoute(route: AppRoute): AppRoute | undefined {
  if (route.overlays.length) return { ...route, overlays: route.overlays.slice(0, -1) }
  const page = route.page
  if (page.page === 'inventory' && page.view !== 'list') return { ...route, page: { page: 'inventory', view: 'list' } }
  if (page.page === 'characters') {
    if (page.view === 'new') return { ...route, page: { page: 'characters', view: 'list' } }
    if (page.view === 'snapshot' || page.view === 'snapshot-compare' || page.view === 'snapshot-pair') return { ...route, page: { page: 'characters', view: 'character', characterId: page.characterId, tab: 'history' } }
    if (page.view !== 'list' && page.view !== 'character') return { ...route, page: { page: 'characters', view: 'character', characterId: page.characterId, tab: page.view === 'class-new' || page.view === 'class-edit' ? 'classes' : page.view === 'learning-new' || page.view === 'learning-edit' ? page.learningKind : 'current' } }
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
  if (page.page === 'settings') return INVENTORY_ROUTE
  return undefined
}

export function isRouteWithin(route: AppRoute, scope: AppRoute): boolean {
  const routeHash = formatAppRoute(route)
  const scopeHash = formatAppRoute(scope)
  const routePath = routeHash.split('?', 1)[0]
  const scopePath = scopeHash.split('?', 1)[0]
  return routePath === scopePath || routePath.startsWith(`${scopePath}/`)
}

function navigationState(value: unknown): NavigationHistoryState | undefined {
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

function withNavigationState(state: unknown, navigation: NavigationHistoryState) {
  return state && typeof state === 'object' ? { ...state, [NAVIGATION_STATE_KEY]: navigation } : { [NAVIGATION_STATE_KEY]: navigation }
}

function writeRouteHistory(next: AppRoute, replace: boolean, notify: boolean): number {
  const currentRoute = parseAppRoute(window.location.hash)
  const currentState = navigationState(window.history.state)
  const currentIndex = currentState?.index ?? 0
  const nextIndex = replace ? currentIndex : currentIndex + 1
  const enteringSettings = next.page.page === 'settings' && currentRoute.page.page !== 'settings'
  const remainingInSettings = next.page.page === 'settings' && currentRoute.page.page === 'settings'
  const state = withNavigationState(window.history.state, {
    index: nextIndex,
    ...(replace && currentState?.parentHash ? { parentHash: currentState.parentHash } : !replace ? { parentHash: formatAppRoute(currentRoute) } : {}),
    ...(enteringSettings ? { returnHash: formatAppRoute(currentRoute), returnIndex: currentIndex }
      : remainingInSettings && currentState?.returnHash && currentState.returnIndex !== undefined ? { returnHash: currentState.returnHash, returnIndex: currentState.returnIndex }
      : {}),
  })
  window.history[replace ? 'replaceState' : 'pushState'](state, '', formatAppRoute(next))
  if (notify) notifyNavigationWrite()
  return nextIndex
}

export function writeNavigationRoute(route: AppRoute, mode: 'push' | 'replace' = 'replace'): void {
  if (typeof window !== 'undefined') writeRouteHistory(route, mode === 'replace', true)
}

export interface NavigationBlocker {
  readonly scope: AppRoute
  readonly blocked: () => boolean
  readonly onBlocked?: () => void
}

export interface NavigationController {
  readonly route: AppRoute
  readonly destination: Destination
  readonly navigate: (route: AppRoute, options?: { readonly replace?: boolean }) => boolean
  readonly close: () => boolean
  readonly href: (route: AppRoute) => string
  readonly registerBlocker: (blocker: NavigationBlocker) => () => void
}

export function useNavigationController(options: { readonly shouldBlock?: (from: AppRoute, to: AppRoute) => boolean; readonly onBlocked?: () => void } = {}): NavigationController {
  const [route, setRoute] = useState(() => typeof window === 'undefined' ? INVENTORY_ROUTE : parseAppRoute(window.location.hash))
  const acceptedRef = useRef(route)
  const acceptedIndexRef = useRef(0)
  const pendingReversalRef = useRef<{ readonly index: number; readonly hash: string } | undefined>(undefined)
  const blockersRef = useRef(new Set<NavigationBlocker>())
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    document.title = routeTitle(route)
  }, [route])

  const blocked = useCallback((from: AppRoute, to: AppRoute) => {
    if (optionsRef.current.shouldBlock?.(from, to)) { optionsRef.current.onBlocked?.(); return true }
    for (const blocker of blockersRef.current) {
      if (!blocker.blocked() || isRouteWithin(to, blocker.scope)) continue
      blocker.onBlocked?.()
      return true
    }
    return false
  }, [])

  const accept = useCallback((next: AppRoute) => {
    const canonical = next.legacy ? { ...next, legacy: undefined } : next
    acceptedRef.current = canonical
    setRoute(canonical)
    if (next.legacy) window.history.replaceState(window.history.state, '', formatAppRoute(canonical))
  }, [])

  useEffect(() => {
    const existing = navigationState(window.history.state)
    const initialIndex = existing?.index ?? 0
    acceptedIndexRef.current = initialIndex
    if (!existing) window.history.replaceState(withNavigationState(window.history.state, { index: initialIndex }), '', window.location.href)
    if (acceptedRef.current.legacy) accept(acceptedRef.current)
    const restore = (event: Event) => {
      const next = parseAppRoute(window.location.hash)
      const nextHash = formatAppRoute(next)
      const state = navigationState(event instanceof PopStateEvent ? event.state : window.history.state)
      const pending = pendingReversalRef.current
      if (pending) {
        if ((state?.index === pending.index || !state) && nextHash === pending.hash) {
          pendingReversalRef.current = undefined
          if (state) acceptedIndexRef.current = state.index
          accept(next)
        }
        return
      }
      if (!next.legacy && nextHash === formatAppRoute(acceptedRef.current)) {
        if (state) acceptedIndexRef.current = state.index
        return
      }
      if (blocked(acceptedRef.current, next)) {
        const delta = state ? acceptedIndexRef.current - state.index : -1
        pendingReversalRef.current = { index: acceptedIndexRef.current, hash: formatAppRoute(acceptedRef.current) }
        window.history.go(delta || -1)
        return
      }
      if (state) acceptedIndexRef.current = state.index
      else {
        const inferredIndex = acceptedIndexRef.current + 1
        window.history.replaceState(withNavigationState(window.history.state, { index: inferredIndex }), '', window.location.href)
        acceptedIndexRef.current = inferredIndex
      }
      accept(next)
    }
    window.addEventListener('popstate', restore)
    window.addEventListener('hashchange', restore)
    window.addEventListener(NAVIGATION_EVENT, restore)
    return () => {
      window.removeEventListener('popstate', restore)
      window.removeEventListener('hashchange', restore)
      window.removeEventListener(NAVIGATION_EVENT, restore)
    }
  }, [accept, blocked])

  const navigate = useCallback((next: AppRoute, navigateOptions?: { readonly replace?: boolean }) => {
    if (blocked(acceptedRef.current, next)) return false
    const replace = navigateOptions?.replace === true
    acceptedIndexRef.current = writeRouteHistory(next, replace, false)
    accept(next)
    return true
  }, [accept, blocked])

  const close = useCallback(() => {
    const currentState = navigationState(window.history.state)
    if (acceptedRef.current.page.page === 'settings' && acceptedRef.current.overlays.length === 0) {
      const returnRoute = currentState?.returnHash ? parseAppRoute(currentState.returnHash) : INVENTORY_ROUTE
      if (blocked(acceptedRef.current, returnRoute)) return false
      if (currentState?.returnIndex !== undefined && currentState.returnIndex !== acceptedIndexRef.current) {
        window.history.go(currentState.returnIndex - acceptedIndexRef.current)
        return true
      }
      return navigate(returnRoute, { replace: true })
    }
    const parent = parentRoute(acceptedRef.current)
    if (!parent || blocked(acceptedRef.current, parent)) return false
    if (currentState?.parentHash === formatAppRoute(parent)) { window.history.back(); return true }
    return navigate(parent, { replace: true })
  }, [blocked, navigate])

  const registerBlocker = useCallback((blocker: NavigationBlocker) => {
    blockersRef.current.add(blocker)
    return () => blockersRef.current.delete(blocker)
  }, [])

  return useMemo(() => ({ route, destination: routeDestination(route), navigate, close, href: formatAppRoute, registerBlocker }), [close, navigate, registerBlocker, route])
}

const NavigationContext = createContext<NavigationController | undefined>(undefined)

export function NavigationProvider({ controller, children }: PropsWithChildren<{ readonly controller: NavigationController }>) {
  return <NavigationContext.Provider value={controller}>{children}</NavigationContext.Provider>
}

export function useNavigation(): NavigationController {
  const value = useContext(NavigationContext)
  if (!value) throw new Error('NavigationProvider is required')
  return value
}

export function useNavigationBlocker(scope: AppRoute, dirty: boolean | (() => boolean), onBlocked?: () => void): void {
  const { registerBlocker } = useNavigation()
  const dirtyRef = useRef(dirty)
  const blockedRef = useRef(onBlocked)
  dirtyRef.current = dirty
  blockedRef.current = onBlocked
  const scopeHash = formatAppRoute(scope)
  useEffect(() => registerBlocker({ scope, blocked: () => typeof dirtyRef.current === 'function' ? dirtyRef.current() : dirtyRef.current, onBlocked: () => blockedRef.current?.() }), [registerBlocker, scopeHash])
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

export function notifyNavigationWrite(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(NAVIGATION_EVENT))
}
