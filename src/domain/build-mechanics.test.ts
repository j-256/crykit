import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { analyzeBuildEquipment } from './build-mechanics'
import { calculateBuildStats, physicalHitChance, statContributions } from './build-stats'
import { estimateAbility } from './ability-estimates'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { CRYSTAL_EDIT_FIELDS, STAT_KEYS } from './crystal-edit'
import { definitionWithMechanics, equipmentFacts, equipmentRole, passivePointCost } from './mechanics-facts'
import { asId, upsertCharacterClassProgress, validateScenario } from './index'
import { addTestBuild, addTestCharacter, addTestDefinition, addTestScenario, createTestProfile, HAND_SLOT, known as knowledge, personalRef, SECOND_HAND_SLOT, TEST_RULESET_REVISION_ID } from './test-helpers'
import type { BuildRevisionContent, BuildRevisionId, CatalogEntity, CatalogRef, CharacterId, EntityId, EntityRef, JsonValue, ScenarioId } from './types'

const known = (value: JsonValue) => ({ state: 'known' as const, value })
const ref = (id: string): CatalogRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: id as EntityId })
const job: CatalogEntity = { id: 'job' as EntityId, kind: 'class', name: 'Synthetic caster', aliases: [], fields: { [CRYSTAL_EDIT_FIELDS.equipment]: known(['Staff', 'Light Body', 'Accessory']), [CRYSTAL_EDIT_FIELDS.ratings]: known(Object.fromEntries(STAT_KEYS.map(stat => [stat, 60]))), 'Innate passive(s)': known('Synthetic bonus: Max MP +20%') }, sources: [] }
const sword: CatalogEntity = { id: 'sword' as EntityId, kind: 'item', name: 'Synthetic sword', aliases: [], fields: { Category: known(['Swords']), Hands: known(1), Attack: known(30), 'Other effects': known('-') }, sources: [] }
const greatsword: CatalogEntity = { ...sword, id: 'greatsword' as EntityId, name: 'Synthetic greatsword', fields: { ...sword.fields, Hands: known(2) } }
const passive: CatalogEntity = { id: 'permission' as EntityId, kind: 'passive', name: 'Synthetic permission', aliases: [], fields: { Description: known('Enable equipping Sword regardless of current Class.') }, sources: [] }
const base: BuildRevisionContent = { primaryClass: ref('job'), secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { level: 20, growth: [{ classRef: ref('job'), levels: 20 }], bonuses: [], statuses: [] } }
const definitions = [job, sword, greatsword, passive]
const resolve = (reference: EntityRef) => reference.kind === 'catalog' ? definitions.find(entity => entity.id === reference.entityId) : undefined
const analyze = (content: BuildRevisionContent) => analyzeBuildEquipment(content, SUGGESTED_BUILD_SLOTS, resolve)

describe('equipment planning from source facts', () => {
  it('uses the primary class and explicit permission passives, independently of ownership', () => {
    const content = { ...base, equipment: { 'plan-main-hand': { ref: ref('sword') } } }
    expect(analyze(content)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CLASS_EQUIPMENT_PERMISSION', status: 'invalid' })]))
    const allowed = { ...content, passives: [{ ref: ref('permission') }] }
    expect(analyze(allowed)).toEqual([])
    const secondaryResolver = (reference: EntityRef) => reference.kind === 'catalog' && reference.entityId === 'swordsman' ? { ...job, fields: { ...job.fields, [CRYSTAL_EDIT_FIELDS.equipment]: known(['Sword']) } } : resolve(reference)
    expect(analyzeBuildEquipment({ ...content, secondaryClass: ref('swordsman') }, SUGGESTED_BUILD_SLOTS, secondaryResolver).some(issue => issue.code === 'CLASS_EQUIPMENT_PERMISSION')).toBe(true)
  })

  it('reserves both hands for a two-handed weapon and counts an explicitly shared copy once', () => {
    const content = { ...base, equipment: { 'plan-main-hand': { ref: ref('greatsword') } }, passives: [{ ref: ref('permission') }] }
    expect(analyze(content)).toEqual([])
    expect(analyze({ ...content, equipment: { ...content.equipment, 'plan-off-hand': { ref: ref('sword') } } }).some(issue => issue.code === 'TWO_HAND_CONFLICT')).toBe(true)
    const shared = { ref: ref('greatsword'), allocationId: 'both-hands' }
    const grouped = { ...content, equipment: { ...content.equipment, 'plan-main-hand': shared, 'plan-off-hand': shared } }
    expect(analyze(grouped)).toEqual([])
    expect(calculateBuildStats(grouped, SUGGESTED_BUILD_SLOTS, resolve).stats.ATK.value).toEqual({ low: 30, high: 30 })
  })

  it('detects wrong roles, duplicate passives, unique copies, and invalid shared allocations', () => {
    const unique: CatalogEntity = { ...sword, fields: { 'Crystal Edit source record': known({ EquipmentType: 18, IsTwoHanded: false, IsOneOnly: true, StatMods: [] }) } }
    const custom = (reference: EntityRef) => reference.kind === 'catalog' && reference.entityId === sword.id ? unique : resolve(reference)
    expect(analyzeBuildEquipment({ ...base, equipment: { 'plan-accessory-1': { ref: ref('sword') }, 'plan-accessory-2': { ref: ref('sword') } } }, SUGGESTED_BUILD_SLOTS, custom).some(issue => issue.code === 'UNIQUE_EQUIPMENT')).toBe(true)
    const content = { ...base, equipment: { 'plan-head': { ref: ref('sword') } }, passives: [{ ref: ref('permission') }, { ref: ref('permission') }] }
    expect(analyze(content).map(issue => issue.code)).toEqual(expect.arrayContaining(['EQUIPMENT_ROLE', 'DUPLICATE_PASSIVE']))
    const selection = { ref: ref('sword'), allocationId: 'not-a-two-handed-copy' }
    expect(analyze({ ...base, equipment: { 'plan-main-hand': selection, 'plan-off-hand': selection } }).some(issue => issue.code === 'EQUIPMENT_ALLOCATION_HANDS')).toBe(true)
  })

  it('uses explicit innate effects for dual wield and shapeshift without granting secondary equipment types', () => {
    const ninja = { ...job, fields: { ...job.fields, [CRYSTAL_EDIT_FIELDS.equipment]: known(['Sword']), 'Innate passive(s)': known('Synthetic innate: Equip two One-Handed weapons at the same time to attack with each one, but decrease Attack by 35%.*') } }
    const content = { ...base, equipment: { 'plan-main-hand': { ref: ref('sword') }, 'plan-off-hand': { ref: ref('sword') } } }
    const custom = (reference: EntityRef) => reference.kind === 'catalog' && reference.entityId === job.id ? ninja : resolve(reference)
    expect(analyzeBuildEquipment(content, SUGGESTED_BUILD_SLOTS, custom)).toEqual([])
    expect(calculateBuildStats(content, SUGGESTED_BUILD_SLOTS, custom).stats.ATK.value).toEqual({ low: 39, high: 39 })
    const mimic = { ...job, fields: { ...job.fields, 'Innate passive(s)': known("Synthetic innate: Gain the innate passive(s) of your current Sub-Command's Class.") } }
    const mimicResolver = (reference: EntityRef) => reference.kind === 'catalog' && reference.entityId === 'mimic' ? mimic : custom(reference)
    const findings = analyzeBuildEquipment({ ...content, primaryClass: ref('mimic'), secondaryClass: ref('job') }, SUGGESTED_BUILD_SLOTS, mimicResolver)
    expect(findings.some(issue => issue.code === 'DUAL_WIELD_REQUIRED')).toBe(false)
    expect(findings.some(issue => issue.code === 'CLASS_EQUIPMENT_PERMISSION')).toBe(true)
  })

  it('retains conflicts and explicit custom rules while interpreting supplied equipment fields', () => {
    const conflict = { ...sword, fields: { ...sword.fields, Category: { state: 'conflicting' as const, claims: [{ value: ['Swords'], sources: [] }, { value: ['Shields'], sources: [] }] } } }
    expect(equipmentFacts(conflict).type).toBeUndefined()
    const custom = { ...sword, slotKinds: { state: 'known' as const, value: ['custom-slot'] }, requirements: { state: 'known' as const, value: [] } }
    expect(definitionWithMechanics(custom, SUGGESTED_BUILD_SLOTS).slotKinds).toBe(custom.slotKinds)
    expect(definitionWithMechanics(custom, SUGGESTED_BUILD_SLOTS).requirements).toBe(custom.requirements)
    expect(equipmentFacts({ ...sword, fields: { ...sword.fields, 'Attack/Hands': known('2-Handed') } }).hands).toBeUndefined()
    const customRole = { ...custom, slotKinds: { state: 'known' as const, value: ['plan-head'] } }
    expect(analyzeBuildEquipment({ ...base, equipment: { 'plan-head': { ref: ref('sword') } } }, SUGGESTED_BUILD_SLOTS, reference => reference.kind === 'catalog' && reference.entityId === sword.id ? customRole : resolve(reference))).toEqual([])
    expect(equipmentRole({ ...SUGGESTED_BUILD_SLOTS[0]!, equipmentRole: null })).toBeUndefined()
    expect(equipmentRole({ ...SUGGESTED_BUILD_SLOTS[0]!, equipmentRole: undefined })).toBe('mainHand')
    const conflictingJob = { ...job, grants: { state: 'conflicting' as const, claims: [{ value: ['equipment:Sword'], sources: [] }, { value: [], sources: [] }] } }
    expect(analyzeBuildEquipment({ ...base, equipment: { 'plan-main-hand': { ref: ref('sword') } } }, SUGGESTED_BUILD_SLOTS, reference => reference.kind === 'catalog' && reference.entityId === job.id ? conflictingJob : resolve(reference))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CLASS_EQUIPMENT_PERMISSION', status: 'undetermined' })]))
  })

  it('feeds documented roles and implicit two-hand occupancy into scenario validation', () => {
    let profile = addTestCharacter(createTestProfile(), 'character')
    profile = addTestDefinition(profile, 'job', { kind: 'class', requirements: { state: 'unknown' }, grants: { state: 'unknown' } })
    profile = addTestDefinition(profile, 'weapon', { slotKinds: { state: 'unknown' }, occupiesSlots: { state: 'unknown' }, requirements: { state: 'unknown' } })
    const ruleset = profile.rulesets[TEST_RULESET_REVISION_ID]!
    profile = { ...profile, rulesets: { ...profile.rulesets, [ruleset.id]: { ...ruleset, slots: ruleset.slots.map(slot => ({ ...slot, ...(slot.id === HAND_SLOT ? { equipmentRole: 'mainHand' as const } : slot.id === SECOND_HAND_SLOT ? { equipmentRole: 'offHand' as const } : {}) })) } }, personalDefinitions: { ...profile.personalDefinitions, job: { ...profile.personalDefinitions.job!, fields: { ...job.fields, [CRYSTAL_EDIT_FIELDS.equipment]: known(['Sword']) } }, weapon: { ...profile.personalDefinitions.weapon!, fields: greatsword.fields } } }
    profile = upsertCharacterClassProgress(profile, { characterId: asId<CharacterId>('character'), classRef: personalRef('job'), unlocked: knowledge(true) })
    profile = addTestBuild(profile, 'build', 'character', { [HAND_SLOT]: { ref: personalRef('weapon') } }, { primaryClass: personalRef('job') })
    profile = addTestScenario(profile, { character: asId<BuildRevisionId>('build-revision') })
    const report = validateScenario(profile, asId<ScenarioId>('scenario'))
    expect(report.dimensions.equipment.status).toBe('valid')
    expect(report.issues.some(issue => issue.code === 'SLOT_OCCUPANCY_MISMATCH')).toBe(false)
  })
})

describe('supported build calculations', () => {
  it('calculates guide growth, innate percentages, and derived stats without creating observations', () => {
    const result = calculateBuildStats(base, SUGGESTED_BUILD_SLOTS, resolve)
    expect(result.stats.STR.value).toEqual({ low: 69, high: 69 })
    expect(result.stats.MP.base?.low).toBeCloseTo(68)
    expect(result.stats.MP.value?.low).toBeCloseTo(81.6)
    expect(result.stats.CRIT.value?.low).toBeCloseTo(100 * 69 / 319)
    expect(result.stats.CRIT_DAMAGE.value?.low).toBeCloseTo(25 + (69 / 15) ** 1.35)
    expect(result.stats.PPEN.value?.low).toBeCloseTo(100 * 69 / 369)
    expect(result.stats.TT.value?.low).toBeCloseTo(34 + (0.0175 * (69 - 600)) ** 2)
  })

  it('keeps incomplete growth unknown, reports mixed flat/percent order, and refuses conflicting duplicate fields', () => {
    const gear = { ...sword, fields: { ...sword.fields, 'Max mp': known(10), 'Attack/Pierce/Hands': known('Attack: +30\n1-Handed') } }
    const custom = (reference: EntityRef) => reference.kind === 'catalog' && reference.entityId === sword.id ? gear : resolve(reference)
    const result = calculateBuildStats({ ...base, equipment: { 'plan-main-hand': { ref: ref('sword') } } }, SUGGESTED_BUILD_SLOTS, custom)
    expect(result.stats.ATK.flat).toBe(30)
    expect(result.stats.MP.value?.low).toBeCloseTo(91.6)
    expect(result.stats.MP.value?.high).toBeCloseTo(93.6)
    expect(result.issues.some(issue => issue.includes('stacking order'))).toBe(true)
    const incomplete = calculateBuildStats({ ...base, calculation: { ...base.calculation!, growth: [] } }, SUGGESTED_BUILD_SLOTS, resolve)
    expect(incomplete.stats.STR.value).toBeNull()
    expect(incomplete.stats.CRIT.value).toBeNull()
    const conflict = statContributions({ ...gear, fields: { ...gear.fields, Stat: known('Attack +90') } })
    expect(conflict.contributions.some(entry => entry.stat === 'ATK')).toBe(false)
    expect(conflict.excluded.some(message => message.includes('conflicting Attack'))).toBe(true)
    const conflictResolver = (reference: EntityRef) => reference.kind === 'catalog' && reference.entityId === sword.id ? { ...gear, fields: { ...gear.fields, Stat: known('Attack +90') } } : resolve(reference)
    expect(calculateBuildStats({ ...base, equipment: { 'plan-main-hand': { ref: ref('sword') } } }, SUGGESTED_BUILD_SLOTS, conflictResolver).stats.ATK.value).toBeNull()
  })

  it('uses percentage-point units for crits and preserves unknown numeric modifier tags', () => {
    expect(statContributions({ ...passive, fields: { Description: known('Crit. Chance +20%.') } }).contributions).toMatchObject([{ stat: 'CRIT', kind: 'flat', value: 20 }])
    const native = statContributions({ ...passive, fields: { 'Crystal Edit source record': known({ StatMods: [{ Tag: 999, Value1: 50 }] }) } })
    expect(native.contributions).toEqual([])
    expect(native.excluded[0]).toContain('not mapped')
    expect(passivePointCost({ ...passive, fields: { 'Crystal Edit source record': known({ PP: 0 }) } })).toMatchObject({ state: 'known', value: 0 })
  })

  it('reads bundled data without doubling repeated fields or hiding disagreements', () => {
    const shoes = Object.values(DEFAULT_CATALOG.entities).find(entity => entity.name === 'Acrobat Shoes' && entity.kind === 'item')!
    expect(equipmentFacts(shoes).unique).toBe(true)
    expect(statContributions(shoes).excluded.some(message => message.includes('conflicting Dexterity'))).toBe(true)
    const sword = Object.values(DEFAULT_CATALOG.entities).find(entity => entity.name === 'Short Sword' && entity.kind === 'item')!
    expect(statContributions(sword).contributions.filter(entry => entry.stat === 'ATK')).toHaveLength(1)
  })

  it('only evaluates documented hit-rate intervals and handles boundaries', () => {
    expect([150, 125, 100, 87.5, 75, 50, 25, 0].map(acc => physicalHitChance(acc, 100))).toEqual([100, 98, 95, 90, 80, 50, 20, 0])
    expect([110, 1, -1, NaN].map(acc => physicalHitChance(acc, 100))).toEqual([null, null, null, null])
    expect(physicalHitChance(100, 0)).toBeNull()
  })

  it('previews allowed ability coefficients and native costs, never executing source text', () => {
    const stats = calculateBuildStats(base, SUGGESTED_BUILD_SLOTS, resolve).stats
    const cure: CatalogEntity = { ...passive, kind: 'ability', fields: { Description: known('Recovery: 50 + 1.5 Spi\nCan use out of combat.'), Cost: known('6 MP\n10 CT') } }
    const result = estimateAbility(cure, stats)
    expect(result.baseAmount).toEqual({ low: 153.5, high: 153.5 })
    expect(result.costs).toEqual({ HP: null, MP: 6, AP: null, CT: 10, CD: null })
    expect(estimateAbility({ ...cure, fields: { Description: known('Damage: globalThis.fetch("/leak")') } }, stats).baseAmount).toBeNull()
    expect(estimateAbility({ ...cure, fields: { Description: known('Damage: 50 x x Spi') } }, stats).baseAmount).toBeNull()
    const native = estimateAbility({ ...cure, fields: { 'Crystal Edit source record': known({ JP: 150, HPCost: 10, MPCost: 0, APCost: 6, CTCost: 10, CDCost: 1, BasePower: 50, BasePAtkRate: 0, ScalingPower: null, ScalingPAtkRate: null, StrRate: 0, VitRate: 0, DexRate: 0, AgiRate: 0, MndRate: 0, SpiRate: 300, SpdRate: 0, LckRate: 0 }) } }, stats)
    expect(native.learning).toEqual({ jp: 150, displayedLp: 1, requiredWholeLp: 2 })
    expect(native.baseAmount).toEqual({ low: 153.5, high: 153.5 })
    expect(native.costs.MP).toBe(0)
  })
})
