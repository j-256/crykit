/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import schema from './reference-schema.json' with { type: 'json' }
import entityData from './entity-reference.json' with { type: 'json' }
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { parseDocument } from './document'
import { createResolver, getEnumCatalog } from './reference'

const resolver = (data: unknown) => createResolver(parseDocument(JSON.stringify({ EditorVersion: 34, ...data as object })))
const effectCode = (table: string, name: string) => Number(Object.entries(NATIVE_GAME_DATA.enums[table]!).find(([, label]) => label === name)![0])

describe('versioned Mod Inspector lookups', () => {
  it('resolves field-world entity IDs, pins source evidence, and keeps unknown IDs explicit', () => {
    const lookup = resolver({ Tree: [{ ModelTypeID: 18, ModelID: 4 }, { ModelTypeID: 18, ModelID: 1 }, { ModelTypeID: 18, ModelID: 999999 }] })
    expect(lookup.annotate(['Tree', 0, 'ModelID'])).toMatchObject({ label: 'Npc: Z1_IntroNan', status: 'resolved' })
    expect(lookup.annotate(['Tree', 0, 'ModelID'])?.detail).toContain('Spawning Meadows')
    expect(lookup.annotate(['Tree', 0, 'ModelID'])?.provenance).toContain(entityData.source.world.sha256)
    expect(lookup.annotate(['Tree', 0])?.provenance).toBe(lookup.annotate(['Tree', 0, 'ModelID'])?.provenance)
    expect(lookup.annotate(['Tree', 1, 'ModelID'])?.label).toBe('Treasure: Tonic')
    expect(lookup.annotate(['Tree', 2, 'ModelID'])?.status).toBe('unknown')
    expect(lookup.referenceId).toContain(entityData.contentDigest)
    expect(lookup.annotate(['Tree', 2, 'ModelID'])?.detail).not.toContain('not bundled')
  })
  it('uses local entity fields and related overrides without copying base fields or linking its own ID', () => {
    const text = '{"EditorVersion":34,"Entities":[{"ID":4,"EntityType":0,"NpcData":{"Key":"Synthetic override"}},{"ID":90000,"EntityType":5,"TreasureData":{"LootType":1,"LootValue":18}}],"Items":[{"ID":18,"Name":"Synthetic Tonic"}],"Tree":[{"ModelTypeID":18,"ModelID":4}]}'
    const document = parseDocument(text)
    const lookup = createResolver(document)
    expect(lookup.annotate(['Tree', 0, 'ModelID'])).toMatchObject({ label: 'Npc: Synthetic override', targetPath: ['Entities', 0] })
    expect(lookup.annotate(['Entities', 0])?.detail).toContain('Biome unknown; Coord (?, ?, ?)')
    expect(lookup.annotate(['Entities', 0])?.detail).toContain('replaces base Npc: Z1_IntroNan without inheriting')
    expect(lookup.annotate(['Entities', 1])?.label).toBe('Treasure: Synthetic Tonic')
    expect(lookup.annotate(['Entities', 0, 'ID'])?.targetPath).toBeUndefined()
    const options = lookup.options(['Entities', 0, 'ID'])
    expect(options.filter(option => option.value === '4')).toHaveLength(1)
    expect(options.find(option => option.value === '4')?.label).toBe('Npc: Synthetic override')
    expect(lookup.annotate(['Entities', 0, 'ID'])?.detail).toContain('Choosing an ID retargets this entity only')
    expect(options.find(option => option.value === '1')?.detail).not.toContain('Choosing an ID')
    expect(options.find(option => option.value === '1')?.detail).not.toContain(entityData.source.world.sha256)
    expect(options.find(option => option.value === '1')?.provenance).toContain(entityData.source.world.sha256)
    expect(lookup.annotate(['Entities', 0, 'ID'])?.provenance).toContain(entityData.contentDigest)
    expect(options.find(option => option.value === '90000')?.source).toBe('mod')
    expect(lookup.relationships(['Entities', 1]).filter(edge => edge.direction === 'outgoing')).toEqual([expect.objectContaining({ path: ['Entities', 1, 'TreasureData', 'LootValue'], targetPath: ['Items', 0] })])
    expect(document.text).toBe(text)
  })
  it('keeps duplicate and malformed entity IDs ambiguous or unknown', () => {
    const lookup = resolver({ Entities: [{ ID: 4, EntityType: 0, NpcData: { Key: 'First' } }, { ID: 4, EntityType: 0, NpcData: { Key: 'Second' } }, { ID: 2147483648, EntityType: 0 }], Tree: [{ ModelTypeID: 18, ModelID: 4 }] })
    expect(lookup.annotate(['Tree', 0, 'ModelID'])?.status).toBe('ambiguous')
    expect(lookup.annotate(['Entities', 0, 'ID'])?.status).toBe('ambiguous')
    expect(lookup.annotate(['Entities', 2, 'ID'])?.status).toBe('unknown')
    expect(lookup.options(['Entities', 0, 'ID']).find(option => option.value === '4')?.label).toContain('Ambiguous')
    expect(lookup.options(['Entities', 0, 'ID']).some(option => option.value === '2147483648')).toBe(false)
  })
  it('exposes every bundled exact enum name without opening a document', () => {
    for (const [name, entries] of Object.entries(NATIVE_GAME_DATA.enums)) {
      const catalog = getEnumCatalog().find(item => item.name === name)!
      for (const [value, label] of Object.entries(entries)) expect(catalog.entries).toContainEqual(expect.objectContaining({ value, label, source: 'enum' }))
    }
    expect(getEnumCatalog().find(item => item.name === 'SangStatModTag')!.entries).toContainEqual(expect.objectContaining({ value: '477', label: 'RevealStatsAuto' }))
    expect(getEnumCatalog().find(item => item.name === 'ReactionType')).toBeDefined()
    expect(getEnumCatalog().find(item => item.name === 'TreeModelType')).toBeDefined()
  })

  it('resolves all stat and ability tag names only inside the matching model', () => {
    for (const [field, table] of [['StatMods', 'SangStatModTag'], ['AbilityMods', 'SangAbilityModTag']] as const) {
      const entries = Object.entries(NATIVE_GAME_DATA.enums[table]!)
      const collection = field === 'StatMods' ? 'Passives' : 'Abilities'
      const lookup = resolver({ [collection]: [{ ID: 90000, [field]: entries.map(([value]) => ({ Tag: Number(value) })) }], Unrelated: { Tag: 477 } })
      entries.forEach(([, name], index) => expect(lookup.annotate([collection, 0, field, index, 'Tag'])?.label).toBe(name))
      expect(lookup.annotate(['Unrelated', 'Tag'])).toBeUndefined()
    }
  })

  it('uses effect-specific parameter selectors and retains unknown scalar quantities', () => {
    const lookup = resolver({ Passives: [{ ID: 90000, StatMods: [
      { Tag: 477, Value1: 999, Value2: 999, Value3: 999 },
      { Tag: effectCode('SangStatModTag', 'PElement'), Value1: 1, Value2: 1 },
      { Tag: effectCode('SangStatModTag', 'Reaction'), Value1: 0, Value2: 90000 },
    ] }], Abilities: [{ ID: 90000, Name: 'Synthetic reaction' }] })
    expect(lookup.annotate(['Passives', 0, 'StatMods', 0, 'Value1'])?.status).toBe('unused')
    expect(lookup.annotate(['Passives', 0, 'StatMods', 1, 'Value1'])?.kind).toBe('enum')
    expect(lookup.options(['Passives', 0, 'StatMods', 1, 'Value1'])).toEqual(getEnumCatalog().find(item => item.name === 'ElementType')!.entries)
    expect(lookup.annotate(['Passives', 0, 'StatMods', 1, 'Value2'])?.status).toBe('unknown')
    expect(lookup.annotate(['Passives', 0, 'StatMods', 2, 'Value2'])?.label).toBe('Synthetic reaction')
  })

  it('resolves direct enum arrays while leaving containers and invalid types without scalar options', () => {
    const lookup = resolver({ Jobs: [{ ID: 90000, EquipmentTypes: [1, 2], AbilityIDs: [0] }], Abilities: [{ ID: 90000, EnabledWeaponTypes: [1], Attribute: [1] }] })
    expect(lookup.annotate(['Jobs', 0, 'EquipmentTypes', 0])?.label).toBe(NATIVE_GAME_DATA.enums.EquipmentType!['1'])
    expect(lookup.annotate(['Abilities', 0, 'EnabledWeaponTypes', 0])?.label).toBe(NATIVE_GAME_DATA.enums.EquipmentType!['1'])
    expect(lookup.options(['Jobs', 0, 'EquipmentTypes', 0]).length).toBeGreaterThan(0)
    expect(lookup.annotate(['Jobs', 0, 'AbilityIDs'])).toBeUndefined()
    expect(lookup.annotate(['Jobs', 0, 'EquipmentTypes'])).toBeUndefined()
    expect(lookup.options(['Jobs', 0, 'AbilityIDs'])).toEqual([])
    expect(lookup.annotate(['Abilities', 0, 'Attribute'])?.status).toBe('unknown')
    expect(lookup.options(['Abilities', 0, 'Attribute'])).toEqual([])
    expect(lookup.issues.some(issue => issue.message.includes('Expected a numeric enum code'))).toBe(true)
  })

  it('gives unique mod-local IDs precedence and leaves duplicates and missing IDs unresolved', () => {
    const base = NATIVE_GAME_DATA.databases.ability as { ID: number; Name: string }[]
    const id = base[0]!.ID
    const lookup = resolver({ Abilities: [{ ID: id, Name: 'Synthetic override' }, { ID: 90000, Name: 'Duplicate A' }, { ID: 90000, Name: 'Duplicate B' }], Jobs: [{ ID: 90000, AbilityIDs: [id, base[1]!.ID, 90000, 999999] }] })
    expect(lookup.annotate(['Jobs', 0, 'AbilityIDs', 0])).toMatchObject({ label: 'Synthetic override', status: 'resolved', targetPath: ['Abilities', 0] })
    expect(lookup.annotate(['Jobs', 0, 'AbilityIDs', 1])?.label).toBe(base[1]!.Name)
    expect(lookup.annotate(['Jobs', 0, 'AbilityIDs', 2])).toMatchObject({ status: 'ambiguous' })
    expect(lookup.annotate(['Jobs', 0, 'AbilityIDs', 2])?.targetPath).toBeUndefined()
    expect(lookup.annotate(['Jobs', 0, 'AbilityIDs', 3])?.status).toBe('unknown')
    expect(lookup.options(['Jobs', 0, 'AbilityIDs', 0]).filter(option => option.value === String(id))).toHaveLength(1)
    expect(lookup.issues.some(issue => issue.message.includes('Duplicate ability'))).toBe(true)
  })

  it('keeps exact integer ID lexemes separate across families without rounding', () => {
    const lookup = createResolver(parseDocument('{"EditorVersion":34,"Abilities":[{"ID":9007199254740993,"Name":"Exact ability"}],"Passives":[{"ID":9007199254740993,"Name":"Exact passive"}],"Jobs":[{"ID":90000,"AbilityIDs":[9007199254740993],"PassiveIDs":[9007199254740993]}]}'))
    expect(lookup.annotate(['Jobs', 0, 'AbilityIDs', 0])?.label).toBe('Exact ability')
    expect(lookup.annotate(['Jobs', 0, 'PassiveIDs', 0])?.label).toBe('Exact passive')
    expect(lookup.options(['Jobs', 0, 'AbilityIDs', 0]).find(option => option.source === 'mod')?.value).toBe('9007199254740993')
  })

  it('navigates incoming and outgoing references for records, tree nodes, learn nodes, and recursive conditions', () => {
    const lookup = resolver({ Abilities: [{ ID: 90000, Name: 'Synthetic ability' }], Passives: [{ ID: 90000, Name: 'Synthetic passive' }], Statuses: [{ ID: 90000, Name: 'Synthetic status' }],
      Jobs: [{ ID: 90000, LearnTree: [[{ NodeType: 2, DataID: 90000 }, { NodeType: 3, DataID: 90000 }]] }],
      Tree: [{ ModelTypeID: 0, ModelID: 90000, Children: [] }],
      Monsters: [{ ID: 90000, Actions: [{ AbilityID: 90000, Conds: [{ CondGroup: 1, SubConds: [{ CondVar: effectCode('ActionConditionVar', 'SelfSpecificStatusCount'), Data1: 90000, CondEval: 0 }] }] }] }],
    })
    expect(lookup.annotate(['Jobs', 0, 'LearnTree', 0, 0, 'DataID'])?.label).toBe('Synthetic ability')
    expect(lookup.annotate(['Jobs', 0, 'LearnTree', 0, 1, 'DataID'])?.label).toBe('Synthetic passive')
    expect(lookup.annotate(['Tree', 0, 'ModelID'])?.targetPath).toEqual(['Abilities', 0])
    expect(lookup.annotate(['Monsters', 0, 'Actions', 0, 'Conds', 0, 'SubConds', 0, 'Data1'])?.label).toBe('Synthetic status')
    expect(lookup.relationships(['Abilities', 0]).filter(edge => edge.direction === 'incoming')).toHaveLength(3)
    expect(lookup.relationships(['Jobs', 0]).filter(edge => edge.direction === 'outgoing')).toHaveLength(2)
    expect(lookup.relationships(['Tree', 0])[0]?.targetPath).toEqual(['Abilities', 0])
  })

  it('resolves nested entity discriminator enums and inspects entity outgoing references explicitly', () => {
    const lookup = resolver({ Jobs: [{ ID: 90000, Name: 'Synthetic crystal job' }], Entities: [{ ID: 90000, CrystalData: { JobID: 90000 }, NpcData: { Pages: [{ Condition: { ConditionType: 2, Data: { Op: 0, LHS: { ConditionType: 5, Data: { LootType: 1, LootValue: 999999 } } } } }] } }] })
    expect(lookup.annotate(['Entities', 0, 'NpcData', 'Pages', 0, 'Condition', 'Data', 'Op'])?.kind).toBe('enum')
    expect(lookup.annotate(['Entities', 0, 'NpcData', 'Pages', 0, 'Condition', 'Data', 'LHS', 'Data', 'LootType'])?.label).toBe('Item')
    expect(lookup.relationships(['Jobs', 0])).toEqual([])
    expect(lookup.issues.some(issue => issue.message.includes('uninspected entity action records are excluded'))).toBe(true)
    expect(lookup.relationships(['Entities', 0]).find(edge => edge.direction === 'outgoing')?.targetPath).toEqual(['Jobs', 0])
    expect(lookup.relationships(['Jobs', 0])[0]?.direction).toBe('incoming')
  })

  it('preserves unfamiliar prototype-like keys and safely inspects their nested arrays', () => {
    const lookup = createResolver(parseDocument('{"EditorVersion":34,"__proto__":[477],"constructor":{},"toString":1,"Jobs":[{"ID":90000,"__proto__":[{"constructor":[477]}],"constructor":[477],"toString":477}]}'))
    for (const path of [['__proto__', 0], ['constructor'], ['toString'], ['Jobs', 0, '__proto__', 0, 'constructor', 0], ['Jobs', 0, 'constructor', 0], ['Jobs', 0, 'toString']] as const) {
      expect(lookup.annotate(path)).toBeUndefined()
      expect(lookup.options(path)).toEqual([])
      expect(lookup.relationships(path)).toEqual([])
    }
    expect(lookup.relationships([])).toEqual([])
  })

  it('resolves evidenced entity, biome, member-default and randomizer ID selectors', () => {
    const randomizerFields = Object.keys(schema.references.ModelSystemRandomizer)
    const lookup = resolver({ Items: [{ ID: 90000, Name: 'Synthetic item' }], Equipment: [{ ID: 90000, Name: 'Synthetic equipment' }], Abilities: [{ ID: 90000, Name: 'Synthetic ability' }], Jobs: [{ ID: 90000, Name: 'Synthetic job', LearnTree: [[{ NodeType: 4, DataID: 42 }]] }], Passives: [{ ID: 90000, Name: 'Synthetic passive' }], Troops: [{ ID: 90000, Name: 'Synthetic troop' }], Genders: [{ ID: 90000, Name: 'Synthetic gender' }], Difficulties: [{ ID: 90000, Name: 'Synthetic difficulty' }], Sparks: [{ ID: 90000, Name: 'Synthetic spark' }], Biomes: [{ ID: 90000, Name: 'Synthetic biome', BaseID: 90000 }],
      System: { MemberDefaults: [{ JobID: 90000, GenderID: 90000, SubJobID: 90000 }], Randomizer: { ...Object.fromEntries(randomizerFields.map(field => [field, [90000]])), ItemPrerequisiteTree: [{ ID: 90000, Children: [{ ID: 90000, Children: [] }] }], EquipmentPrerequisiteTree: [{ ID: 90000, Children: [] }], ItemCounts: [{ ID: 90000, Min: 1, Tot: 2 }] } },
      Entities: [{ ID: 90000, BiomeID: 90000, DoorData: { RequiredItemID: 90000 }, SparkData: { SparkID: 90000, TroopPages: [{ MinDifficultyID: 90000 }] }, NpcData: { Outfits: [{ VoxelID: 90000 }], Pages: [{ Condition: { ConditionType: 29, Data: { InvalidItemID: 90000 } } }] } }],
    })
    const cases = [
      [['Biomes', 0, 'BaseID'], 'Synthetic biome'],
      [['System', 'MemberDefaults', 0, 'GenderID'], 'Synthetic gender'],
      [['System', 'MemberDefaults', 0, 'SubJobID'], 'Synthetic job'],
      [['Entities', 0, 'BiomeID'], 'Synthetic biome'],
      [['Entities', 0, 'DoorData', 'RequiredItemID'], 'Synthetic item'],
      [['Entities', 0, 'SparkData', 'SparkID'], 'Synthetic spark'],
      [['Entities', 0, 'SparkData', 'TroopPages', 0, 'MinDifficultyID'], 'Synthetic difficulty'],
      [['Entities', 0, 'NpcData', 'Pages', 0, 'Condition', 'Data', 'InvalidItemID'], 'Synthetic item'],
      [['System', 'Randomizer', 'ItemPrerequisiteTree', 0, 'Children', 0, 'ID'], 'Synthetic item'],
      [['System', 'Randomizer', 'EquipmentPrerequisiteTree', 0, 'ID'], 'Synthetic equipment'],
      [['System', 'Randomizer', 'ItemCounts', 0, 'ID'], 'Synthetic item'],
    ] as const
    for (const [path, label] of cases) expect(lookup.annotate(path)).toMatchObject({ label, kind: 'reference', status: 'resolved' })
    for (const field of randomizerFields) {
      expect(lookup.annotate(['System', 'Randomizer', field, 0])?.status).toBe('resolved')
      expect(lookup.options(['System', 'Randomizer', field, 0]).some(option => option.source === 'mod')).toBe(true)
      expect(lookup.options(['System', 'Randomizer', field])).toEqual([])
    }
    expect(lookup.relationships(['System', 'Randomizer']).length).toBeGreaterThanOrEqual(randomizerFields.length)
    expect(lookup.annotate(['Entities', 0, 'NpcData', 'Outfits', 0, 'VoxelID'])).toMatchObject({ status: 'unknown', label: expect.stringContaining('Unknown voxel') })
    expect(lookup.annotate(['Jobs', 0, 'LearnTree', 0, 0, 'DataID'])).toMatchObject({ status: 'unknown', label: expect.stringContaining('Growth node data') })
  })

  it('uses the evidenced Atlas selector instead of guessing from the MonsterID field name', () => {
    const lookup = resolver({ Monsters: [{ ID: 90000, Name: 'Synthetic atlas monster' }], Entities: [{ ID: 90000, NpcData: { Pages: [{ Condition: { ConditionType: 17, Data: { Type: 1, LootValue: 90000, MonsterID: 90000 } } }] } }] })
    const path = ['Entities', 0, 'NpcData', 'Pages', 0, 'Condition', 'Data'] as const
    expect(lookup.annotate([...path, 'LootValue'])).toMatchObject({ kind: 'reference', label: 'Synthetic atlas monster' })
    expect(lookup.annotate([...path, 'MonsterID'])).toMatchObject({ kind: 'parameter', status: 'unknown' })
    expect(lookup.options([...path, 'MonsterID'])).toEqual([])
  })

  it('classifies every declared ID-shaped field in the coverage ledger', () => {
    for (const [model, fields] of Object.entries(schema.models)) for (const field of Object.keys(fields)) {
      if (!/IDs?$/.test(field)) continue
      expect(schema.idFieldCoverage.some(entry => entry.model === model && entry.field === field)).toBe(true)
    }
  })

  it('resolves minimal supplemental animation, voxel and editor-folder names with scoped provenance', () => {
    const lookup = resolver({ Abilities: [{ ID: 90000, AnimationID: 0 }], Entities: [{ ID: 90000, NpcData: { Outfits: [{ VoxelID: 1 }] } }], Tree: [{ ModelTypeID: 3, ModelID: 0 }, { ModelTypeID: 15, ModelID: 0 }] })
    expect(lookup.annotate(['Abilities', 0, 'AnimationID'])).toMatchObject({ label: schema.baselines.animation.records.find(record => record.ID === 0)!.Name, status: 'resolved', detail: expect.stringContaining(schema.baselines.animation.source.sha256) })
    expect(lookup.annotate(['Entities', 0, 'NpcData', 'Outfits', 0, 'VoxelID'])).toMatchObject({ label: schema.baselines.voxel.records.find(record => record.ID === 1)!.Name, status: 'resolved' })
    expect(lookup.annotate(['Tree', 0, 'ModelID'])).toMatchObject({ label: schema.baselines.folder.records.find(record => record.ID === 0)!.Name, detail: expect.stringContaining('editor tree organization only') })
    expect(lookup.options(['Tree', 1, 'ModelID'])).toHaveLength(schema.baselines.animation.records.length)
    const override = resolver({ Animations: [{ ID: 0, Name: 'Synthetic animation override' }], Folders: [{ ID: 0, Name: 'Synthetic folder override' }], Tree: [{ ModelTypeID: 3, ModelID: 0 }], Abilities: [{ ID: 90000, AnimationID: 0 }] })
    expect(override.annotate(['Abilities', 0, 'AnimationID'])?.label).toBe('Synthetic animation override')
    expect(override.annotate(['Tree', 0, 'ModelID'])?.targetPath).toEqual(['Folders', 0])
    const absent = resolver({ Tree: [{ ModelTypeID: 13, ModelID: 999999 }] })
    expect(absent.annotate(['Tree', 0, 'ModelID'])?.status).toBe('unknown')
    expect(absent.options(['Tree', 0, 'ModelID'])).toHaveLength(schema.baselines.voxel.records.length)
    const animationIDs = new Set(schema.baselines.animation.records.map(record => record.ID))
    const missingSlot = Array.from({ length: schema.baselines.animation.source.slotCount }, (_, id) => id).find(id => !animationIDs.has(id))!
    expect(resolver({ Tree: [{ ModelTypeID: 15, ModelID: missingSlot }] }).annotate(['Tree', 0, 'ModelID'])?.status).toBe('unknown')
  })

  it('pins the exact factual schema including supplemental source hashes', () => {
    const canonicalJson = (value: unknown): string => {
      if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
      if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}'
      return JSON.stringify(value)
    }
    const { contentDigest, ...content } = schema
    expect(createHash('sha256').update(canonicalJson(content)).digest('hex')).toBe(contentDigest)
    expect(resolver({}).referenceId).toContain(contentDigest)
    for (const baseline of Object.values(schema.baselines)) expect(baseline.source.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('reports unknown enums, selector restrictions, unsupported scope, and unavailable baselines', () => {
    const lookup = resolver({ EditorVersion: 4, Platform: 'Switch', Entities: [{ ID: 90000 }], Passives: [{ ID: 90000, StatMods: [{ Tag: 999999 }, { Tag: effectCode('SangStatModTag', 'DamageOnApply'), Value1: 6 }] }] })
    expect(lookup.annotate(['Passives', 0, 'StatMods', 0, 'Tag'])?.status).toBe('unknown')
    expect(lookup.annotate(['Passives', 0, 'StatMods', 1, 'Value1'])?.restrictions?.[0]).toContain('runtime acceptance is unverified')
    expect(lookup.issues.map(issue => issue.message).join(' ')).not.toContain('Base entity records are not bundled')
    expect(lookup.issues.some(issue => issue.path[0] === 'EditorVersion')).toBe(true)
    expect(lookup.sourceLabel).toContain('Windows 1.6.9')
    expect(lookup.referenceId).toContain(NATIVE_GAME_DATA.contentDigest)
  })
})

describe('editor format and navigation metadata', () => {
  it('describes format markers without modifying imported text or applying conversions', () => {
    for (const [marker, state] of [['4', 'older'], ['31', 'older'], ['34', 'matched'], ['35', 'newer'], ['"34"', 'invalid'], ['34.0', 'invalid'], ['null', 'invalid'], ['-1', 'invalid'], ['2147483648', 'invalid'], ['9007199254740993', 'invalid']] as const) {
      const text = `{ "EditorVersion": ${marker}, "Abilities": [{"ID": 90000,"HideIfUnusable":true}] }`
      const document = parseDocument(text)
      const lookup = createResolver(document)
      expect(lookup.editorVersion).toMatchObject({ state, value: marker, referenceVersion: 34 })
      expect(lookup.annotate(['EditorVersion'])).toMatchObject({ kind: 'metadata', detail: expect.stringContaining('does not convert data') })
      expect(document.text).toBe(text)
      expect(document.root.raw).toBe(text)
    }
    const missing = createResolver(parseDocument('{"Tree":[]}'))
    expect(missing.editorVersion).toMatchObject({ state: 'missing', detail: expect.stringContaining('default a missing marker to 0') })
    expect(missing.editorVersion.value).toBeUndefined()
    expect(resolver({}).editorVersion.detail).toContain('not a guarantee')
  })

  it('summarizes nested folders and direct targets without adding relationship edges', () => {
    const data = { Folders: [{ ID: 90000, Name: 'Synthetic folder' }], Passives: [{ ID: 90000, Name: 'Synthetic passive' }], Tree: [
      { ModelTypeID: 3, ModelID: 90000, SortOrder: 8, IsExpanded: false, Children: [{ ModelTypeID: 7, ModelID: 90000, SortOrder: 2, IsExpanded: true, Children: [] }] },
      { ModelTypeID: 7, ModelID: 90000, Children: [] },
    ], Unrelated: { Tree: [{ ModelTypeID: 7, ModelID: 90000, Children: [] }] } }
    const lookup = resolver(data)
    expect(lookup.annotate(['Tree'])).toMatchObject({ kind: 'metadata', label: 'Crystal Edit navigation' })
    expect(lookup.annotate(['Tree', 0])).toMatchObject({ kind: 'metadata', label: 'Synthetic folder (ModelFolder, ModelID 90000)', targetPath: ['Folders', 0] })
    expect(lookup.annotate(['Tree', 0, 'Children', 0])).toMatchObject({ kind: 'metadata', label: 'Synthetic passive (ModelPassive, ModelID 90000)', targetPath: ['Passives', 0] })
    expect(lookup.annotate(['Tree', 0, 'Children'])?.label).toBe('Navigation children')
    expect(lookup.annotate(['Tree', 0, 'SortOrder'])?.detail).toContain('preserves stored array order')
    expect(lookup.annotate(['Tree', 0, 'IsExpanded'])?.detail).toContain('CryKit expansion is independent')
    expect(lookup.annotate(['Tree', 0, 'ModelTypeID'])?.detail).toContain('not a C# enum')
    expect(lookup.annotate(['Unrelated', 'Tree'])).toBeUndefined()
    expect(lookup.annotate(['Unrelated', 'Tree', 0])).toBeUndefined()
    expect(lookup.relationships(['Tree']).filter(edge => edge.direction === 'outgoing')).toHaveLength(3)
    expect(lookup.relationships(['Tree']).every(edge => edge.path.at(-1) === 'ModelID')).toBe(true)
  })

  it('keeps malformed, missing, unknown and duplicate navigation targets explicit', () => {
    const lookup = resolver({ Passives: [{ ID: 90000, Name: 'First' }, { ID: 90000, Name: 'Second' }], Tree: [
      { ModelTypeID: 7, ModelID: 90000, Children: [] },
      { ModelTypeID: 7, ModelID: 90001, Children: [] },
      { ModelTypeID: 90000, ModelID: 90000, Children: [] },
      { ModelTypeID: '7', ModelID: 90000, Children: [] },
      { ModelTypeID: 7, ModelID: {}, SortOrder: '0', IsExpanded: 1 },
      { ModelTypeID: 7 },
    ] })
    expect(lookup.annotate(['Tree', 0])).toMatchObject({ kind: 'metadata', status: 'ambiguous' })
    expect(lookup.annotate(['Tree', 0])?.targetPath).toBeUndefined()
    for (const index of [1, 2, 3, 4, 5]) expect(lookup.annotate(['Tree', index])).toMatchObject({ kind: 'metadata', status: 'unknown' })
    expect(lookup.annotate(['Tree', 4, 'SortOrder'])?.status).toBe('unknown')
    expect(lookup.annotate(['Tree', 4, 'IsExpanded'])?.status).toBe('unknown')
    expect(lookup.relationships(['Tree']).filter(edge => edge.direction === 'outgoing')).toHaveLength(2)
  })
  it('bounds malformed navigation identifier summaries without changing imported data', () => {
    const oversized = 'x'.repeat(20000)
    const text = JSON.stringify({ EditorVersion: 34, Tree: [
      { ModelTypeID: oversized, ModelID: { value: oversized } },
      { ModelTypeID: 7, ModelID: oversized },
    ] })
    const document = parseDocument(text)
    const lookup = createResolver(document)
    for (const index of [0, 1]) {
      const annotation = lookup.annotate(['Tree', index])!
      expect(annotation.status).toBe('unknown')
      expect(annotation.label.length).toBeLessThan(200)
    }
    expect(lookup.annotate(['Tree', 0])?.label).toContain('ModelID object')
    expect(document.text).toBe(text)
  })

})
