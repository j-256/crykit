import { defaultBattleCalculation } from './battle-plan'
import { buildBehavior } from './build-behavior'
import { buildContentForModSetup } from './build-mods'
import { cloneBuild } from './builds'
import { calculateBuildCombatPreview } from './combat-preview'
import { compareActiveStatusImpact, listActiveStatusImpactChoices } from './combat-status-impact'
import { catalogEntity } from './entity-identities'
import { resolveGameRules } from './game-rules'
import { expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { NativeLocalDataSchema, NativeLocalData240Schema } from '../interchange/native-schema'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { createSharePayload } from '../interchange/share'
import { defaultCalculation } from './calculation-plan'
import { calculatePCStats } from './pc-stats'
import { validateBuildContent } from './build-validity'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { addTestBuild, createTestLocalData, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } from './test-helpers'
import { saveSharedTeam, saveTeamSlotAsBuild } from './team-checkpoints'
import type { BuildRevisionContent, CatalogRef, EntityRef, LocalData } from './types'
const ref: CatalogRef = { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'base:job:0' as never }
const content: BuildRevisionContent = { primaryClass: ref, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: defaultCalculation(ref) }
const resolve = (value: EntityRef) => value.kind === 'catalog' ? DEFAULT_CATALOG.entities[value.entityId] : undefined
const setupId = TEST_GAME_SETUP_REVISION_ID
function adapted() {
  const data = createTestLocalData()
  return saveSharedTeam(data, { title: 'Unresolved', gameSetupRevisionId: setupId, slots: [{ id: 'slot' as never, content, createdAt: TEST_NOW }, null, null, null] })
}
function revision(data: LocalData) { return Object.values(data.teamRevisions)[0]! }
it('marks incompatible exact references unresolved and never reads old local mechanics, including independent Build reopen', () => {
  const data = adapted(), slot = revision(data).slots[0]!
  expect(slot.content.primaryClass).toEqual(ref)
  expect(slot.content.retainedSelections).toEqual({ refs: [ref], slotIds: [] })
  validateNativeLocalDataGraph(data, [DEFAULT_CATALOG])
  const report = validateBuildContent(slot.content, data.gameSetups[setupId], SUGGESTED_BUILD_SLOTS, resolve)
  expect(report.status).toBe('undetermined')
  expect(calculatePCStats(slot.content, SUGGESTED_BUILD_SLOTS, resolve).neutral.HP).toBeNull()
  const saved = saveTeamSlotAsBuild(data, { teamRevisionId: revision(data).id, slot: 0, title: 'Independent', expectedRevision: data.revision })
  const reopened = NativeLocalDataSchema.parse(JSON.parse(JSON.stringify(saved))) as unknown as LocalData
  validateNativeLocalDataGraph(reopened, [DEFAULT_CATALOG])
  const copied = Object.values(reopened.buildRevisions)[0]!
  expect(copied.content).toEqual(slot.content)
  expect(calculatePCStats(copied.content, SUGGESTED_BUILD_SLOTS, resolve).neutral.HP).toBeNull()
  expect(() => createSharePayload(reopened, { kind: 'build', revisionId: copied.id }, false, [DEFAULT_CATALOG])).toThrow()
})
it('rejects duplicate, unselected, same-name-other-revision and compatible markers without altering inputs', () => {
  const data = adapted(), checkpoint = revision(data), slot = checkpoint.slots[0]!
  const invalid = [
    { refs: [ref, ref], slotIds: [] },
    { refs: [{ ...ref, catalogRevisionId: 'foreign-revision' as never }], slotIds: [] },
    { refs: [ref], slotIds: ['hand'] },
    { refs: [], slotIds: [] },
  ]
  for (const marker of invalid) {
    const malformed = { ...data, teamRevisions: { [checkpoint.id]: { ...checkpoint, slots: [{ ...slot, content: { ...slot.content, retainedSelections: marker } }, null, null, null] } } } as LocalData
    expect(() => validateNativeLocalDataGraph(malformed, [DEFAULT_CATALOG])).toThrow()
  }
  const compatible = { ...data, teamRevisions: { [checkpoint.id]: { ...checkpoint, catalogLock: { [ref.catalogId]: ref.catalogRevisionId } } } }
  expect(() => validateNativeLocalDataGraph(compatible, [DEFAULT_CATALOG])).toThrow()
})
it('admits an exact unavailable identity receipt only for absent sources, never corrupt complete catalogs', () => {
  const data = adapted()
  expect(() => validateNativeLocalDataGraph(data, [])).toThrow()
  const receipt = { ref, kind: 'class' as const, name: 'Recorded class' }
  const unavailable = { ...data, unavailableDefinitions: [receipt] }
  validateNativeLocalDataGraph(unavailable, [])
  const corrupt = { ...DEFAULT_CATALOG, entities: {}, claims: [] }
  expect(() => validateNativeLocalDataGraph(unavailable, [corrupt])).toThrow()
  const saved = saveTeamSlotAsBuild(unavailable, { teamRevisionId: revision(unavailable).id, slot: 0, title: 'Unresolved copy', expectedRevision: unavailable.revision })
  validateNativeLocalDataGraph(saved, [])
})
it('keeps frozen historical content strict and existing marker-free current values unchanged', () => {
  const data = addTestBuild(createTestLocalData(), 'old', '', {})
  expect(NativeLocalDataSchema.parse(data)).toEqual(data)
  const { teamRevisions: _team, ...base } = data
  const frozen = { ...base, schemaVersion: '2.4.0' }
  expect(NativeLocalData240Schema.parse(frozen)).toEqual(frozen)
  const build = frozen.buildRevisions['old-revision']!
  expect(NativeLocalData240Schema.safeParse({ ...frozen, buildRevisions: { [build.id]: { ...build, content: { ...build.content, retainedSelections: { refs: [], slotIds: [] } } } } }).success).toBe(false)
})

it('keeps retained growth, ability, status and battle inputs inert even with exact native definitions available', () => {
  const selected = (id: string): CatalogRef => ({ ...ref, entityId: id as never })
  const hunter = selected('base:job:7'), growth = selected('base:job:0'), ability = selected('base:ability:147'), target = selected('base:monster:95'), status = selected('base:status:12')
  const baseline: BuildRevisionContent = { primaryClass: hunter, secondaryClass: null, equipment: { 'plan-main-hand': { ref: selected('base:equipment:300') } }, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(hunter), ability, battle: { ...defaultBattleCalculation(), target, statuses: [{ ref: status, count: 3 }] } } }
  const rules = resolveGameRules({ mode: { state: 'known', value: 'Standard' }, difficulty: { version: 1, selection: { state: 'known', value: 0 } } }, [])
  const full = (value: EntityRef) => value.kind === 'catalog' ? catalogEntity(DEFAULT_CATALOG, value.entityId) : undefined
  expect(calculateBuildCombatPreview(baseline, SUGGESTED_BUILD_SLOTS, full, rules).damage).toBe(1278)
  const retained = (value: EntityRef, source = baseline): BuildRevisionContent => ({ ...source, retainedSelections: { refs: [value], slotIds: [] } })
  expect(calculateBuildCombatPreview(retained(ability), SUGGESTED_BUILD_SLOTS, full, rules).costs.MP).toBeNull()
  expect(calculateBuildCombatPreview(retained(target), SUGGESTED_BUILD_SLOTS, full, rules).damage).toBeNull()
  const withStatus = retained(status)
  const choice = listActiveStatusImpactChoices(withStatus, full, rules)[0]!
  expect(choice.name).toBe('Power Up')
  const impact = compareActiveStatusImpact(withStatus, SUGGESTED_BUILD_SLOTS, full, choice, rules)!
  expect(impact.current.damage).toBeNull()
  expect(impact.automaticStatus).toBe('unknown')
  const growthContent = { ...baseline, calculation: { ...baseline.calculation!, growth: [{ classRef: growth, levels: baseline.calculation!.level }] } }
  expect(calculatePCStats(growthContent, SUGGESTED_BUILD_SLOTS, full).neutral.HP).not.toBeNull()
  expect(calculatePCStats(retained(growth, growthContent), SUGGESTED_BUILD_SLOTS, full).neutral.HP).toBeNull()
  const absentSlot = { ...baseline, equipment: { ...baseline.equipment, 'old-slot': { ref: selected('base:equipment:300') } }, retainedSelections: { refs: [], slotIds: ['old-slot' as never] } }
  expect(calculatePCStats(absentSlot, SUGGESTED_BUILD_SLOTS, full).neutral.HP).toBeNull()
  expect(calculatePCStats(absentSlot, SUGGESTED_BUILD_SLOTS, full).issues).toContain('Selected equipment exists outside the mapped slot layout.')
})

it('preserves private receipts and exact selections when reopening, editing notes or cloning a saved independent Build', () => {
  const data = adapted(), checkpoint = revision(data)
  const saved = saveTeamSlotAsBuild(data, { teamRevisionId: checkpoint.id, slot: 0, title: 'Independent', expectedRevision: data.revision })
  const source = Object.values(saved.builds)[0]!, original = saved.buildRevisions[source.latestRevisionId!]!
  const cloned = cloneBuild(saved, { sourceBuildId: source.id })
  const copy = Object.values(cloned.buildRevisions).find(value => value.id !== original.id)!
  expect(copy.content).toEqual(original.content)
  const draft = buildContentForModSetup({ ...original.content, rotationNotes: 'Only notes changed' }, buildBehavior(saved.gameSetups[setupId]!), [DEFAULT_CATALOG])
  expect(draft.primaryClass).toEqual(ref)
  expect(draft.retainedSelections).toEqual(original.content.retainedSelections)
  expect(saved.buildRevisions[original.id]).toEqual(original)
  validateNativeLocalDataGraph(cloned, [DEFAULT_CATALOG])
})
