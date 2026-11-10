import { createId } from '../domain/core'
import { modCatalogRevision } from '../domain/mod-layers'
import type { BuildId, BuildRevisionId, GameSetupId, GameSetupRevisionId, LocalData } from '../domain/types'
import suppliedRecords from './starter-build-records.json' with { type: 'json' }

type StarterRecords = Pick<LocalData, 'gameSetups' | 'builds' | 'buildRevisions'>

// This native graph is the supplied editable starter checkpoint, not a publication format
// Apply it only to a freshly constructed sample baseline, never to persisted user records
// Its setup families are already deduplicated; source pins, unknowns, and display receipts are immutable inputs
export function appendStarterBuilds(localData: LocalData): LocalData {
  const records = structuredClone(suppliedRecords) as unknown as StarterRecords
  const setupIds = new Map(Object.keys(records.gameSetups).map(id => [id, createId<GameSetupRevisionId>('gameSetupRevision')]))
  const familyIds = new Map([...new Set(Object.values(records.gameSetups).map(setup => setup.gameSetupId))].map(id => [id, createId<GameSetupId>('gameSetup')]))
  const buildIds = new Map(Object.keys(records.builds).map(id => [id, createId<BuildId>('build')]))
  const revisionIds = new Map(Object.keys(records.buildRevisions).map(id => [id, createId<BuildRevisionId>('buildRevision')]))
  const pins = new Map([...setupIds].map(([id, fresh]) => [modCatalogRevision(id as GameSetupRevisionId) as string, modCatalogRevision(fresh)]))
  const catalogLock = (lock: LocalData['gameSetups'][string]['catalogLock']) => Object.fromEntries(Object.entries(lock).map(([id, revision]) => [id, pins.get(revision) ?? revision])) as typeof lock
  const references = <T,>(value: T): T => {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(entry => references(entry)) as T
    const entry = value as Record<string, unknown>
    // Only native catalog references carry remapped effective setup pins; opaque metadata stays verbatim
    if (entry.kind === 'catalog' && typeof entry.catalogRevisionId === 'string') return { ...entry, catalogRevisionId: pins.get(entry.catalogRevisionId) ?? entry.catalogRevisionId } as T
    return Object.fromEntries(Object.entries(entry).map(([key, child]) => [key, references(child)])) as T
  }
  const gameSetups = { ...localData.gameSetups }
  for (const setup of Object.values(records.gameSetups)) {
    const id = setupIds.get(setup.id)!
    gameSetups[id] = { ...references(setup), id, gameSetupId: familyIds.get(setup.gameSetupId)!, catalogLock: catalogLock(setup.catalogLock) }
  }
  const builds = { ...localData.builds }
  for (const build of Object.values(records.builds)) {
    const id = buildIds.get(build.id)!
    builds[id] = { ...build, id, gameSetupId: familyIds.get(build.gameSetupId)!, latestRevisionId: revisionIds.get(build.latestRevisionId!)! }
  }
  const buildRevisions = { ...localData.buildRevisions }
  for (const revision of Object.values(records.buildRevisions)) {
    const id = revisionIds.get(revision.id)!
    buildRevisions[id] = { ...revision, id, buildId: buildIds.get(revision.buildId)!, gameSetupRevisionId: setupIds.get(revision.gameSetupRevisionId)!, catalogLock: catalogLock(revision.catalogLock), content: references(revision.content) }
  }
  // Initialization adds one baseline, without user edits, history, or changes to existing persisted records
  return { ...localData, gameSetups, builds, buildRevisions }
}
