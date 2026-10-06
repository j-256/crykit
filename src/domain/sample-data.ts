import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { createBuild, saveBuildRevision } from './builds'
import { captureCharacter, createCharacter, upsertCharacterClassProgress } from './characters'
import { createId, DomainError } from './core'
import { observeInventory } from './inventory'
import { addGameSetupRevision, createBlankLocalData, createPlaythrough, DEFAULT_GAME_DIFFICULTY } from './local-data'
import { createScenario } from './scenarios'
import { saveTeam } from './teams'
import type { BuildId, BuildRevisionId, CatalogEntityKind, CatalogRef, CatalogSnapshot, CharacterId, EntityId, EntityRef, LocalData, SourceRef, Timestamp } from './types'

const SAMPLE_NOTE = 'Sample data for exploring the planner. Replace it with your own observations.'
const SAMPLE_SOURCE: SourceRef = { sourceId: 'sample-starter-team', locator: 'Built-in sample playthrough', applicability: SAMPLE_NOTE }
const SAMPLE_LEVEL = 1
const SAMPLE_MEMBERS = [
  {
    name: 'Rowan',
    classId: 'base:job:0',
    equipment: { 'plan-main-hand': 'base:equipment:0', 'plan-off-hand': 'base:equipment:44', 'plan-body': 'base:equipment:18' },
  },
  {
    name: 'Mira',
    classId: 'base:job:4',
    equipment: { 'plan-main-hand': 'base:equipment:5', 'plan-body': 'base:equipment:19' },
  },
  {
    name: 'Tavi',
    classId: 'base:job:2',
    equipment: { 'plan-main-hand': 'base:equipment:3', 'plan-body': 'base:equipment:17' },
  },
  {
    name: 'Sol',
    classId: 'base:job:3',
    equipment: { 'plan-main-hand': 'base:equipment:16', 'plan-body': 'base:equipment:19' },
  },
] as const

function sampleRef(catalog: CatalogSnapshot, id: string, kind: CatalogEntityKind): CatalogRef {
  if (catalog.entities[id]?.kind !== kind) {
    throw new DomainError('INVALID_INPUT', `The sample team requires the bundled ${kind} definition: ${id}`)
  }
  return { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: id as EntityId }
}

export function createSampleLocalData(catalog: CatalogSnapshot, timestamp?: Timestamp | string): LocalData {
  let localData = createBlankLocalData({ now: timestamp })
  const now = localData.createdAt
  const catalogLock = { [catalog.id]: catalog.revisionId }
  localData = addGameSetupRevision(localData, { label: 'Sample starter Game Setup', difficulty: DEFAULT_GAME_DIFFICULTY, slots: SUGGESTED_BUILD_SLOTS, catalogLock, now })
  const gameSetupRevisionId = localData.planningGameSetupRevisionId!
  const gameSetupId = localData.gameSetups[gameSetupRevisionId]!.gameSetupId
  localData = createPlaythrough(localData, { label: 'Sample playthrough', currentGameSetupRevisionId: gameSetupRevisionId, now })
  const assignments: Record<string, BuildRevisionId> = {}
  const teamSlots: BuildRevisionId[] = []
  const memberIds: CharacterId[] = []
  const stock = new Map<string, { ref: CatalogRef; quantity: number }>()

  for (const member of SAMPLE_MEMBERS) {
    const characterId = createId<CharacterId>('character')
    const buildId = createId<BuildId>('build')
    const revisionId = createId<BuildRevisionId>('buildRevision')
    const primaryClass = sampleRef(catalog, member.classId, 'class')
    const equipment: Record<string, EntityRef | null> = Object.fromEntries(SUGGESTED_BUILD_SLOTS.map(slot => [slot.id, null]))
    for (const [slotId, entityId] of Object.entries(member.equipment)) {
      const ref = sampleRef(catalog, entityId, 'item')
      equipment[slotId] = ref
      stock.set(entityId, { ref, quantity: (stock.get(entityId)?.quantity ?? 0) + 1 })
    }
    localData = createCharacter(localData, { id: characterId, name: member.name, appearanceLabel: 'Sample character', now })
    localData = upsertCharacterClassProgress(localData, { characterId, classRef: primaryClass, unlocked: { state: 'known', value: true }, sources: [SAMPLE_SOURCE], now })
    localData = captureCharacter(localData, {
      characterId, gameSetupRevisionId, level: { state: 'known', value: SAMPLE_LEVEL },
      primaryClass: { state: 'known', value: primaryClass },
      secondaryClass: { state: 'notApplicable', reason: 'No secondary class in this sample build' },
      equipment, passives: { state: 'known', value: [] }, sources: [SAMPLE_SOURCE], note: SAMPLE_NOTE, now,
    })
    localData = createBuild(localData, {
      id: buildId, gameSetupId, title: `${member.name}: sample ${catalog.entities[member.classId]!.name}`,
      tags: ['sample'], now,
    })
    localData = saveBuildRevision(localData, {
      buildId, id: revisionId, gameSetupRevisionId, catalogLock, note: SAMPLE_NOTE, now,
      content: {
        primaryClass, secondaryClass: null,
        equipment: Object.fromEntries(Object.entries(equipment).map(([slotId, ref]) => [slotId, ref ? { ref } : null])),
        passives: [],
        contextAssumptions: [SAMPLE_NOTE],
      },
    })
    assignments[characterId] = revisionId
    teamSlots.push(revisionId)
    memberIds.push(characterId)
  }

  for (const { ref, quantity } of stock.values()) {
    localData = observeInventory(localData, { ref, possession: 'owned', quantity: { kind: 'exact', value: quantity }, sources: [SAMPLE_SOURCE], note: SAMPLE_NOTE, now })
  }
  // The saved Team pins the starter checkpoints without coupling later edits to the party plan
  localData = saveTeam(localData, { title: 'Sample starter Team', slots: teamSlots, now })
  localData = createScenario(localData, { label: 'Sample starter team', memberIds, assignments, gameSetupRevisionId, activate: true, now })
  return { ...localData, revision: 0, changes: [] }
}
