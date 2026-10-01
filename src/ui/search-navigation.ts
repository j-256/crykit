import { normalizeWeaponType, type WeaponType } from '../domain/skill-weapons'
import type { BuildId, CharacterId, EntityRef, InventoryPositionId, ProgressRecordId, ScenarioId, TeamId } from '../domain/types'
import { formatAppRoute, parseAppRoute, routeDestination, type AppRoute, type Destination } from './navigation'

export type UniversalSearchTarget =
  | { readonly kind: 'weaponSkills'; readonly weapon: WeaponType }
  | { readonly kind: 'definition'; readonly ref: EntityRef }
  | { readonly kind: 'inventory'; readonly positionId: InventoryPositionId }
  | { readonly kind: 'character'; readonly characterId: CharacterId }
  | { readonly kind: 'build'; readonly buildId: BuildId }
  | { readonly kind: 'team'; readonly teamId: TeamId }
  | { readonly kind: 'scenario'; readonly scenarioId: ScenarioId }
  | { readonly kind: 'progress'; readonly recordId: ProgressRecordId }

export function destinationForSearchTarget(target: UniversalSearchTarget): Destination {
  if (target.kind === 'definition' || target.kind === 'weaponSkills') return 'reference'
  if (target.kind === 'inventory') return 'inventory'
  if (target.kind === 'character') return 'characters'
  if (target.kind === 'team') return 'teams'
  if (target.kind === 'progress') return 'progress'
  return 'builds'
}

export function routeForSearchTarget(target: UniversalSearchTarget): AppRoute {
  if (target.kind === 'weaponSkills') return { page: { page: 'reference', view: 'list' }, overlays: [], query: { v: ['1'], weapon: [target.weapon] } }
  const page = target.kind === 'definition' ? { page: 'reference' as const, view: 'detail' as const, ref: target.ref }
    : target.kind === 'inventory' ? { page: 'inventory' as const, view: 'edit' as const, positionId: target.positionId }
    : target.kind === 'character' ? { page: 'characters' as const, view: 'character' as const, characterId: target.characterId, tab: 'current' as const }
    : target.kind === 'build' ? { page: 'builds' as const, view: 'build' as const, buildId: target.buildId }
    : target.kind === 'team' ? { page: 'teams' as const, view: 'team' as const, teamId: target.teamId }
    : target.kind === 'scenario' ? { page: 'builds' as const, view: 'scenario' as const, scenarioId: target.scenarioId }
    : { page: 'progress' as const, view: 'edit' as const, recordId: target.recordId }
  return { page, overlays: [], query: {} }
}

export function searchTargetForRoute(route: AppRoute): UniversalSearchTarget | undefined {
  const page = route.page
  const weapon = normalizeWeaponType(route.query.weapon?.[0])
  if (page.page === 'reference' && page.view === 'list' && weapon) return { kind: 'weaponSkills', weapon }
  if (page.page === 'reference' && page.view === 'detail') return { kind: 'definition', ref: page.ref }
  if (page.page === 'inventory' && page.view === 'edit') return { kind: 'inventory', positionId: page.positionId }
  if (page.page === 'characters' && page.view !== 'list' && page.view !== 'new') return { kind: 'character', characterId: page.characterId }
  if (page.page === 'builds' && (page.view === 'build' || page.view === 'revision-new' || page.view === 'revision' || page.view === 'revision-edit' || page.view === 'record-current')) return { kind: 'build', buildId: page.buildId }
  if (page.page === 'builds' && page.view === 'scenario') return { kind: 'scenario', scenarioId: page.scenarioId }
  if (page.page === 'teams' && 'teamId' in page) return { kind: 'team', teamId: page.teamId }
  if (page.page === 'progress' && page.view === 'edit') return { kind: 'progress', recordId: page.recordId }
  return undefined
}

export function parseUniversalSearchTarget(hash: string): UniversalSearchTarget | undefined {
  return searchTargetForRoute(parseAppRoute(hash))
}

export function formatSearchDestination(destination: Destination, target?: UniversalSearchTarget): string {
  if (!target) return formatAppRoute({
    page: destination === 'inventory' ? { page: 'inventory', view: 'list' }
      : destination === 'characters' ? { page: 'characters', view: 'list' }
      : destination === 'builds' ? { page: 'builds', view: 'library' }
      : destination === 'teams' ? { page: 'teams', view: 'list' }
      : destination === 'progress' ? { page: 'progress', view: 'list' }
      : destination === 'mods' ? { page: 'mods', view: 'library' }
      : { page: 'reference', view: 'list' },
    overlays: [],
    query: {},
  })
  const route = routeForSearchTarget(target)
  if (routeDestination(route) !== destination) throw new Error('Search target does not belong to the requested destination')
  return formatAppRoute(route)
}
