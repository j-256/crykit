import { type InventoryPositionId, type CharacterId, type CharacterSnapshotId, type BuildId, type BuildRevisionId, type ScenarioId, type ProgressRecordId, type TeamId } from '../../domain/types'
import { type EntityRouteNameResolver } from '../entity-route-names'
import { SHARE_ROUTE_PREFIX, MAX_SHARE_URL_LENGTH } from '../../interchange/share'
import { type Destination, type UnresolvedPageRoute, type PageRoute, PROGRESS_PAGES } from './types.ts'
import { MAX_ROUTE_LENGTH, overlayStartsAt, decodeSegment, encodeIdentitySegment, encodeSegment, COLLECTION_ID_RESERVED_SEGMENTS } from './segments.ts'
import { parseEntityRefPath, formatEntityRefPath } from './entities.ts'

const REVISION_ID_RESERVED_SEGMENTS = new Set(['new'])

const COMPARE_LEFT_ID_RESERVED_SEGMENTS = new Set(['search', 'pick', 'definitions', 'corrections', 'correct'])

export function unresolved(requestedPath: string, recovery: Destination, reason: UnresolvedPageRoute['reason'] = 'unknown-route'): PageRoute {
  return { page: 'unresolved', requestedPath: requestedPath.slice(0, MAX_ROUTE_LENGTH), reason, recovery }
}

export function recoveryFor(segments: readonly string[]): Destination {
  const root = segments[0]
  return root === 'teams' || root === 'inventory' || root === 'characters' || root === 'progress' || root === 'reference' || root === 'mods' || root === 'map' || root === 'save-editor' ? root : 'builds'
}

export function parsePage(segments: readonly string[], requestedPath: string): { readonly page: PageRoute; readonly consumed: number; readonly legacy?: true } {
  const bad = (recovery = recoveryFor(segments), reason?: UnresolvedPageRoute['reason']) => ({ page: unresolved(requestedPath, recovery, reason), consumed: segments.length })
  if (segments[0] === 'save-editor') return overlayStartsAt(segments, 1) ? { page: { page: 'save-editor' }, consumed: 1 } : bad('save-editor')
  if (segments[0] === 'map') return overlayStartsAt(segments, 1) ? { page: { page: 'map' }, consumed: 1 } : bad('map')
  if (segments[0] === 'mods') {
    if (overlayStartsAt(segments, 1)) return { page: { page: 'mods', view: 'library' }, consumed: 1 }
    if (segments[1] === 'editor' && overlayStartsAt(segments, 2)) return { page: { page: 'mods', view: 'editor' }, consumed: 2 }
    return bad('mods')
  }
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
    const currentPage = { page: 'characters', view: 'character', characterId: characterId as CharacterId, tab: 'current' } as const
    if (tab === undefined) return { page: currentPage, consumed: 2, legacy: true }
    if (tab === 'current') {
      if (overlayStartsAt(segments, 3)) return { page: currentPage, consumed: 3 }
      if (segments[3] === 'snapshots' && segments[4] === 'new') return { page: { page: 'characters', view: 'snapshot-new', characterId: characterId as CharacterId }, consumed: 5 }
      if (segments[3] === 'classes' && segments[4] === 'new') return { page: { page: 'characters', view: 'class-new', characterId: characterId as CharacterId }, consumed: 5 }
      if (segments[3] === 'classes') {
        const parsed = parseEntityRefPath(segments, 4)
        if (parsed && segments[4 + parsed.consumed] === 'edit') return { page: { page: 'characters', view: 'class-edit', characterId: characterId as CharacterId, ref: parsed.ref }, consumed: 5 + parsed.consumed }
      }
      if (segments[3] === 'skills' && segments[4] === 'screenshots') return { page: { page: 'characters', view: 'skill-screenshots', characterId: characterId as CharacterId }, consumed: 5 }
      const learningKind = segments[3] === 'skills' && (segments[4] === 'knowledge' || segments[4] === 'magic') ? segments[4] : undefined
      if (learningKind && segments[5] === 'new') return { page: { page: 'characters', view: 'learning-new', characterId: characterId as CharacterId, learningKind }, consumed: 6 }
      if (learningKind) {
        const parsed = parseEntityRefPath(segments, 5)
        if (parsed && segments[5 + parsed.consumed] === 'edit') return { page: { page: 'characters', view: 'learning-edit', characterId: characterId as CharacterId, learningKind, ref: parsed.ref }, consumed: 6 + parsed.consumed }
      }
    }
    if (tab === 'history') {
      if (overlayStartsAt(segments, 3)) return { page: { page: 'characters', view: 'character', characterId: characterId as CharacterId, tab }, consumed: 3 }
      if (segments[3] === 'snapshots') {
        const snapshotId = decodeSegment(segments[4] ?? '')
        return snapshotId ? { page: { page: 'characters', view: 'snapshot', characterId: characterId as CharacterId, snapshotId: snapshotId as CharacterSnapshotId }, consumed: 5 } : bad('characters', 'malformed-identifier')
      }
      if (segments[3] === 'compare') {
        if (overlayStartsAt(segments, 4)) return { page: { page: 'characters', view: 'snapshot-compare', characterId: characterId as CharacterId }, consumed: 4 }
        const leftSnapshotId = decodeSegment(segments[4] ?? '')
        const rightSnapshotId = decodeSegment(segments[5] ?? '')
        return leftSnapshotId && rightSnapshotId ? { page: { page: 'characters', view: 'snapshot-pair', characterId: characterId as CharacterId, leftSnapshotId: leftSnapshotId as CharacterSnapshotId, rightSnapshotId: rightSnapshotId as CharacterSnapshotId }, consumed: 6 } : bad('characters', 'malformed-identifier')
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
    if (overlayStartsAt(segments, 1)) return { page: PROGRESS_PAGES[0].page, consumed: 1, legacy: true }
    const progressPage = PROGRESS_PAGES.find(entry => entry.segment === segments[1])
    if (progressPage && overlayStartsAt(segments, 2)) return { page: progressPage.page, consumed: 2 }
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
  if (segments[0] === 'teams') {
    if (overlayStartsAt(segments, 1)) return { page: { page: 'teams', view: 'list' }, consumed: 1 }
    if (segments[1] === 'new' && overlayStartsAt(segments, 2)) return { page: { page: 'teams', view: 'new' }, consumed: 2 }
    const teamId = decodeSegment(segments[1] ?? '') as TeamId | undefined
    if (!teamId) return bad('teams', 'malformed-identifier')
    if (segments[2] === 'edit' && overlayStartsAt(segments, 3)) return { page: { page: 'teams', view: 'edit', teamId }, consumed: 3 }
    if (segments[2] === 'adopt' && overlayStartsAt(segments, 3)) return { page: { page: 'teams', view: 'adopt', teamId }, consumed: 3 }
    return overlayStartsAt(segments, 2) ? { page: { page: 'teams', view: 'team', teamId }, consumed: 2 } : bad('teams')
  }
  if (segments[0] === 'settings') {
    const section = segments[1]
    if (section !== 'playthrough' && section !== 'data' && section !== 'game-setup' && section !== 'history' && section !== 'storage' && section !== 'credits') return bad('inventory')
    if (section === 'data' && segments[2] === 'import') {
      const previewId = decodeSegment(segments[3] ?? '')
      return previewId ? { page: { page: 'settings', section, previewId }, consumed: 4 } : bad('inventory', 'malformed-identifier')
    }
    return overlayStartsAt(segments, 2) ? { page: { page: 'settings', section }, consumed: 2 } : bad('inventory')
  }
  return bad()
}

export function formatPage(page: PageRoute, resolveName: EntityRouteNameResolver): string {
  if (page.page === 'save-editor') return '/save-editor'
  if (page.page === 'map') return '/map'
  if (page.page === 'mods') return page.view === 'editor' ? '/mods/editor' : '/mods'
  if (page.page === 'teams') return page.view === 'list' ? '/teams' : page.view === 'new' ? '/teams/new' : `/teams/${encodeIdentitySegment(page.teamId, COLLECTION_ID_RESERVED_SEGMENTS)}${page.view === 'adopt' ? '/adopt' : page.view === 'edit' ? '/edit' : ''}`
  if (page.page === 'share') {
    if (!/^[A-Za-z0-9_-]+$/.test(page.encoded) || SHARE_ROUTE_PREFIX.length + page.encoded.length > MAX_SHARE_URL_LENGTH) throw new Error('Share route is invalid')
    return `${SHARE_ROUTE_PREFIX.slice(1)}${page.encoded}`
  }
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
    if (page.view === 'skill-screenshots') return `${root}/current/skills/screenshots`
    if (page.view === 'class-new') return `${root}/current/classes/new`
    if (page.view === 'class-edit') return `${root}/current/classes/${formatEntityRefPath(page.ref, resolveName)}/edit`
    if (page.view === 'learning-new') return `${root}/current/skills/${page.learningKind}/new`
    if (page.view === 'learning-edit') return `${root}/current/skills/${page.learningKind}/${formatEntityRefPath(page.ref, resolveName)}/edit`
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
    const progressPage = PROGRESS_PAGES.find(entry => entry.page.view === page.view)!
    return `/progress/${progressPage.segment}`
  }
  if (page.page === 'reference') {
    if (page.view === 'promote') return '/reference/promote'
    if (page.view === 'detail') return `/reference/${formatEntityRefPath(page.ref, resolveName)}`
    return '/reference'
  }
  if (page.page === 'settings') return `/settings/${page.section}${'previewId' in page ? `/import/${encodeSegment(page.previewId)}` : ''}`
  return page.requestedPath.startsWith('/') ? page.requestedPath : '/inventory'
}
