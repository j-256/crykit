import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { createBuild, saveBuildRevision } from './builds'
import { captureCharacter, createCharacter, upsertCharacterClassProgress } from './characters'
import { createId, DomainError } from './core'
import { observeInventory } from './inventory'
import { addRulesetRevision, createBlankProfile } from './profile'
import { createScenario } from './scenarios'
import type { BuildId, BuildRevisionId, CatalogEntityKind, CatalogRef, CatalogSnapshot, CharacterId, EntityId, EntityRef, Profile, SourceRef, Timestamp } from './types'

const SAMPLE_NOTE = 'Sample data for exploring the planner. Replace it with your own observations.'
const SAMPLE_SOURCE: SourceRef = { sourceId: 'sample-starter-team', locator: 'Built-in sample playthrough', applicability: SAMPLE_NOTE }
const SAMPLE_LEVEL = 1
const SAMPLE_MEMBERS = [
  {
    name: 'Rowan',
    classId: 'base:class:warrior',
    equipment: { 'plan-main-hand': 'base:item:short-sword', 'plan-off-hand': 'base:item:buckler', 'plan-body': 'base:item:breastplate' },
  },
  {
    name: 'Mira',
    classId: 'base:class:cleric',
    equipment: { 'plan-main-hand': 'base:item:short-staff', 'plan-body': 'base:item:hemp-robe' },
  },
] as const

function sampleRef(catalog: CatalogSnapshot, id: string, kind: CatalogEntityKind): CatalogRef {
  if (catalog.entities[id]?.kind !== kind) {
    throw new DomainError('INVALID_INPUT', `The sample team requires the bundled ${kind} definition: ${id}`)
  }
  return { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: id as EntityId }
}

export function createSampleProfile(catalog: CatalogSnapshot, timestamp?: Timestamp | string): Profile {
  let profile = createBlankProfile({ label: 'Sample playthrough', now: timestamp })
  const now = profile.createdAt
  const catalogLock = { [catalog.id]: catalog.revisionId }
  profile = addRulesetRevision(profile, { label: 'Sample starter ruleset', slots: SUGGESTED_BUILD_SLOTS, catalogLock, now })
  const rulesetRevisionId = profile.activeRulesetRevisionId!
  const assignments: Record<string, BuildRevisionId> = {}
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
    profile = createCharacter(profile, { id: characterId, name: member.name, appearanceLabel: 'Sample character', now })
    profile = upsertCharacterClassProgress(profile, { characterId, classRef: primaryClass, unlocked: { state: 'known', value: true }, sources: [SAMPLE_SOURCE], now })
    profile = captureCharacter(profile, {
      characterId, rulesetRevisionId, level: { state: 'known', value: SAMPLE_LEVEL },
      primaryClass: { state: 'known', value: primaryClass },
      secondaryClass: { state: 'notApplicable', reason: 'No secondary class in this sample build' },
      equipment, passives: { state: 'known', value: [] }, sources: [SAMPLE_SOURCE], note: SAMPLE_NOTE, now,
    })
    profile = createBuild(profile, {
      id: buildId, characterId, title: `${member.name}: sample ${catalog.entities[member.classId]!.name}`,
      kind: 'character', tags: ['sample'], now,
    })
    profile = saveBuildRevision(profile, {
      buildId, id: revisionId, rulesetRevisionId, catalogLock, note: SAMPLE_NOTE, now,
      content: {
        primaryClass, secondaryClass: null,
        equipment: Object.fromEntries(Object.entries(equipment).map(([slotId, ref]) => [slotId, ref ? { ref } : null])),
        passives: [],
        contextAssumptions: [SAMPLE_NOTE],
      },
    })
    assignments[characterId] = revisionId
  }

  for (const { ref, quantity } of stock.values()) {
    profile = observeInventory(profile, { ref, possession: 'owned', quantity: { kind: 'exact', value: quantity }, sources: [SAMPLE_SOURCE], note: SAMPLE_NOTE, now })
  }
  profile = createScenario(profile, { label: 'Sample starter team', assignments, rulesetRevisionId, activate: true, now })
  return { ...profile, revision: 0, changes: [] }
}
