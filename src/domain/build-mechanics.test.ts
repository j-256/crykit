import { describe, expect, it } from 'vitest'
import { testCatalogRef as ref } from './catalog.test-helpers'
import { analyzeBuildEquipment, innateEffects, assessEquipmentPermission, buildEquipmentPermissions } from './build-mechanics'
import { calculateBuildStats } from './build-stats'
import { SUGGESTED_BUILD_SLOTS } from './build-planning'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, STAT_KEYS } from './crystal-edit'
import { definitionWithMechanics, equipmentFacts, equipmentRole, passivePointCost } from './mechanics-facts'
import { asId } from './core'
import { upsertCharacterClassProgress } from './characters'
import { validateScenario } from './validation'
import { addTestBuild, addTestCharacter, addTestDefinition, addTestScenario, createTestLocalData, HAND_SLOT, known as knowledge, personalRef, SECOND_HAND_SLOT, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import type { BuildRevisionContent, BuildRevisionId, CatalogEntity, CharacterId, EntityId, EntityRef, JsonValue, ScenarioId } from './types'

const known = (value: JsonValue) => ({ state: 'known' as const, value })
const job: CatalogEntity = { id: 'job' as EntityId, kind: 'class', name: 'Synthetic caster', aliases: [], fields: { [CRYSTAL_EDIT_FIELDS.equipment]: known(['Staff', 'Light Body', 'Accessory']), [CRYSTAL_EDIT_FIELDS.ratings]: known(Object.fromEntries(STAT_KEYS.map(stat => [stat, 60]))), 'Innate passive(s)': known('Synthetic bonus: Max MP +20%') }, sources: [] }
const sword: CatalogEntity = { id: 'sword' as EntityId, kind: 'item', name: 'Synthetic sword', aliases: [], fields: { Category: known(['Swords']), Hands: known(1), Attack: known(30), 'Other effects': known('-') }, sources: [] }
const greatsword: CatalogEntity = { ...sword, id: 'greatsword' as EntityId, name: 'Synthetic greatsword', fields: { ...sword.fields, Hands: known(2) } }
const passive: CatalogEntity = { id: 'permission' as EntityId, kind: 'passive', name: 'Synthetic permission', aliases: [], fields: { Description: known('Enable equipping Sword regardless of current Class.') }, sources: [] }
const base: BuildRevisionContent = { primaryClass: ref('job'), secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { level: 20, growth: [{ classRef: ref('job'), levels: 20 }], bonuses: [], statuses: [] } }
const definitions = [job, sword, greatsword, passive]
const resolve = (reference: EntityRef) => reference.kind === 'catalog' ? definitions.find(entity => entity.id === reference.entityId) : undefined
const analyze = (content: BuildRevisionContent) => analyzeBuildEquipment(content, SUGGESTED_BUILD_SLOTS, resolve)

describe('equipment planning from source facts', () => {
  it('resolves native innates through the exact source of a personal class revision', () => {
    const nativeJob: CatalogEntity = { ...job, legacy: { native: { database: 'job', databaseId: 1, mode: 'base' } }, fields: { ...job.fields, [CLASS_FIELDS.passives]: known([1]) } }
    const innate: CatalogEntity = { ...passive, id: asId('base:passive:1'), kind: 'innate', fields: { Description: known('Synthetic native innate'), 'Native source record': known({ ID: 1, IsInnate: true }) } }
    const data = addTestDefinition(createTestLocalData(), 'synthetic-personal-class', { kind: 'class' })
    const personal = { ...data.personalDefinitions['synthetic-personal-class']!, fields: nativeJob.fields, baseRef: ref('job') }
    const custom = (reference: EntityRef) => reference.kind === 'personal' ? personal : reference.entityId === job.id ? nativeJob : reference.entityId === innate.id ? innate : undefined
    const effects = innateEffects({ ...base, primaryClass: personalRef('synthetic-personal-class') }, custom)
    expect(effects.map(effect => effect.definition.id)).toEqual([innate.id])
    expect(effects[0]!.text).toBe('Synthetic native innate')
  })
  it('uses the primary class and explicit permission passives, independently of ownership', () => {
    const content = { ...base, equipment: { 'plan-main-hand': { ref: ref('sword') } } }
    expect(analyze(content)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CLASS_EQUIPMENT_PERMISSION', status: 'invalid' })]))
    const allowed = { ...content, passives: [{ ref: ref('permission') }] }
    expect(analyze(allowed)).toEqual([])
    const secondaryResolver = (reference: EntityRef) => reference.kind === 'catalog' && reference.entityId === 'swordsman' ? { ...job, fields: { ...job.fields, [CRYSTAL_EDIT_FIELDS.equipment]: known(['Sword']) } } : resolve(reference)
    expect(analyzeBuildEquipment({ ...content, secondaryClass: ref('swordsman') }, SUGGESTED_BUILD_SLOTS, secondaryResolver).some(issue => issue.code === 'CLASS_EQUIPMENT_PERMISSION')).toBe(true)
  })

  it('distinguishes incompatible equipment from unknown permissions and applies permission effects', () => {
    const context = buildEquipmentPermissions(base, resolve)
    expect(assessEquipmentPermission(sword, context)).toEqual({ status: 'invalid', reason: 'Synthetic caster cannot equip Sword' })
    expect(assessEquipmentPermission({ ...sword, fields: { Category: known(['Staves']) } }, context)).toEqual({ status: 'valid' })
    expect(assessEquipmentPermission({ ...sword, fields: {} }, context)).toMatchObject({ status: 'undetermined' })
    expect(assessEquipmentPermission({ ...sword, requirements: { state: 'conflicting', claims: [{ value: [], sources: [] }, { value: [{ kind: 'permission', permission: 'equipment:Sword' }], sources: [] }] } }, context)).toMatchObject({ status: 'undetermined' })
    expect(assessEquipmentPermission({ ...sword, requirements: { state: 'known', value: [] } }, context)).toEqual({ status: 'valid' })
    expect(assessEquipmentPermission(sword, buildEquipmentPermissions({ ...base, primaryClass: null }, resolve))).toMatchObject({ status: 'undetermined' })
    expect(assessEquipmentPermission(sword, buildEquipmentPermissions({ ...base, passives: [{ ref: ref('missing') }] }, resolve))).toMatchObject({ status: 'undetermined' })
    expect(assessEquipmentPermission(sword, buildEquipmentPermissions({ ...base, passives: [{ ref: ref('permission') }] }, resolve))).toEqual({ status: 'valid' })
    expect(analyze({ ...base, equipment: { 'plan-main-hand': { ref: ref('sword') } }, passives: [{ ref: ref('missing') }] })).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CLASS_EQUIPMENT_PERMISSION', status: 'undetermined' })]))
  })

  it('reserves both hands for a two-handed weapon and counts an explicitly shared copy once', () => {
    const content = { ...base, equipment: { 'plan-main-hand': { ref: ref('greatsword') } }, passives: [{ ref: ref('permission') }] }
    expect(analyze(content)).toEqual([])
    expect(analyze({ ...content, equipment: { ...content.equipment, 'plan-off-hand': { ref: ref('sword') } } }).some(issue => issue.code === 'TWO_HAND_CONFLICT')).toBe(true)
    const shared = { ref: ref('greatsword'), allocationId: 'both-hands' }
    const grouped = { ...content, equipment: { ...content.equipment, 'plan-main-hand': shared, 'plan-off-hand': shared } }
    expect(analyze(grouped)).toEqual([])
    expect(calculateBuildStats(grouped, SUGGESTED_BUILD_SLOTS, resolve).stats.ATK.value).toBeNull()
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
    expect(calculateBuildStats(content, SUGGESTED_BUILD_SLOTS, custom).stats.ATK.value).toBeNull()
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
    expect(equipmentFacts({ ...sword, fields: { ...sword.fields, 'Attack/Hands': known('2-Handed') } }).twoHanded).toBeUndefined()
    expect(equipmentFacts({ ...sword, fields: { Category: known(['Staves']) } }).twoHanded).toBe(true)
    expect(equipmentFacts({ ...sword, fields: { Category: known(['Wands']) } }).twoHanded).toBe(false)
    expect(equipmentFacts({ ...sword, fields: { Category: known(['Staves']), Hands: known(1) } }).twoHanded).toBeUndefined()
    const customRole = { ...custom, slotKinds: { state: 'known' as const, value: ['plan-head'] } }
    expect(analyzeBuildEquipment({ ...base, equipment: { 'plan-head': { ref: ref('sword') } } }, SUGGESTED_BUILD_SLOTS, reference => reference.kind === 'catalog' && reference.entityId === sword.id ? customRole : resolve(reference))).toEqual([])
    expect(equipmentRole({ ...SUGGESTED_BUILD_SLOTS[0]!, equipmentRole: null })).toBeUndefined()
    expect(equipmentRole({ ...SUGGESTED_BUILD_SLOTS[0]!, equipmentRole: undefined })).toBe('mainHand')
    const conflictingJob = { ...job, grants: { state: 'conflicting' as const, claims: [{ value: ['equipment:Sword'], sources: [] }, { value: [], sources: [] }] } }
    expect(analyzeBuildEquipment({ ...base, equipment: { 'plan-main-hand': { ref: ref('sword') } } }, SUGGESTED_BUILD_SLOTS, reference => reference.kind === 'catalog' && reference.entityId === job.id ? conflictingJob : resolve(reference))).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CLASS_EQUIPMENT_PERMISSION', status: 'undetermined' })]))
  })

  it('feeds documented roles and handedness into scenario validation', () => {
    let localData = addTestCharacter(createTestLocalData(), 'character')
    localData = addTestDefinition(localData, 'job', { kind: 'class', requirements: { state: 'unknown' }, grants: { state: 'unknown' } })
    localData = addTestDefinition(localData, 'weapon', { slotKinds: { state: 'unknown' }, requirements: { state: 'unknown' } })
    const gameSetup = localData.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    localData = { ...localData, gameSetups: { ...localData.gameSetups, [gameSetup.id]: { ...gameSetup, slots: gameSetup.slots.map(slot => ({ ...slot, ...(slot.id === HAND_SLOT ? { equipmentRole: 'mainHand' as const } : slot.id === SECOND_HAND_SLOT ? { equipmentRole: 'offHand' as const } : {}) })) } }, personalDefinitions: { ...localData.personalDefinitions, job: { ...localData.personalDefinitions.job!, fields: { ...job.fields, [CRYSTAL_EDIT_FIELDS.equipment]: known(['Sword']) } }, weapon: { ...localData.personalDefinitions.weapon!, fields: greatsword.fields } } }
    localData = upsertCharacterClassProgress(localData, { characterId: asId<CharacterId>('character'), classRef: personalRef('job'), unlocked: knowledge(true) })
    localData = addTestBuild(localData, 'build', 'character', { [HAND_SLOT]: { ref: personalRef('weapon') } }, { primaryClass: personalRef('job') })
    localData = addTestScenario(localData, { character: asId<BuildRevisionId>('build-revision') })
    const report = validateScenario(localData, asId<ScenarioId>('scenario'))
    expect(report.dimensions.equipment.status).toBe('valid')
  })
})

describe('native numeric input boundaries', () => {
  it('keeps community descriptions and ratings available as facts without treating them as native numeric inputs', () => {
    const result = calculateBuildStats(base, SUGGESTED_BUILD_SLOTS, resolve)
    expect(result.issues).toContain("No verified numeric data for the primary class.")
    expect(Object.values(result.stats).every(stat => stat.value === null)).toBe(true)
    expect(passivePointCost({ ...passive, fields: { 'Crystal Edit source record': known({ PP: 0 }) } })).toMatchObject({ state: 'known', value: 0 })
  })
})
