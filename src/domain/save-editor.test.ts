import { describe, expect, it } from 'vitest'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { decodeCrystalSave, encodeCrystalSave, type BsonDocument, type BsonValue, type CrystalSave } from '../interchange/crystal-save'
import { createSaveEditorFixture } from './save-editor.fixture'
import { editSave, inspectSave, previewSaveChanges, SAVE_EDITOR_MAX_CURRENCY } from './save-editor'

const NOW = new Date('2026-01-02T03:04:05Z')
const catalog = SAVE_EDITOR_CATALOG
function doc(value: BsonValue | undefined): BsonDocument { if (value?.type !== 'document') throw new Error('Expected document'); return value }
function arr(value: BsonValue | undefined): BsonValue[] { if (value?.type !== 'array') throw new Error('Expected array'); return value.value }
function num(value: BsonValue | undefined): number { if (value?.type !== 'int32') throw new Error('Expected integer'); return value.value }
function flag(save: CrystalSave, key: string): void { doc(save.party.value.GameplayFlags).value[key] = { type: 'boolean', value: true } }

describe('browser-local save editing', () => {
  it.each(Array.from({ length: 29 }, (_, version) => version))('edits format %i without upgrading it or losing unknown records', version => {
    const original = decodeCrystalSave(encodeCrystalSave(createSaveEditorFixture(version)))
    expect(inspectSave(original, catalog).editable).toBe(true)
    const edited = decodeCrystalSave(encodeCrystalSave(editSave(original, catalog, { type: 'overpowered' }, NOW)))
    expect(inspectSave(edited, catalog)).toMatchObject({ editable: true, currency: SAVE_EDITOR_MAX_CURRENCY, levelCap: 99 })
    expect(edited.header.version).toBe(version)
    expect(edited.header.lastUpdated).toEqual(original.header.lastUpdated)
    expect(edited.members.every(member => num(doc(member.value.Levels).value.Level) === 99)).toBe(true)
    expect(edited.party.value.SyntheticInt64).toEqual(original.party.value.SyntheticInt64)
    expect(edited.party.value.QuestState).toEqual(original.party.value.QuestState)
    expect(edited.combatBytes).toEqual(original.combatBytes)
  })

  it('uses native legacy defaults without adding unrelated fields to simple edits', () => {
    const original = createSaveEditorFixture(3)
    original.header.invertedVersion = true
    for (const field of ['Mods', 'RandomizerFlags', 'GameplayFlags', 'Atlas']) delete original.party.value[field]
    for (const member of original.members) {
      for (const field of ['Growth', 'SubJob', 'AutoAbilityID']) delete member.value[field]
      for (const field of ['Hist', 'MaxLevel', 'TotExp']) delete doc(member.value.Levels).value[field]
      delete doc(member.value.JP).value.TotalJP
    }
    expect(inspectSave(original, catalog)).toMatchObject({ editable: true, members: [{ subJobId: null, growthJobId: 0 }, {}, {}, {}] })
    const money = editSave(original, catalog, { type: 'currency', value: 1000 }, NOW)
    expect(money.members).toEqual(original.members)
    for (const field of ['Mods', 'RandomizerFlags', 'GameplayFlags', 'Atlas']) expect(money.party.value[field]).toBeUndefined()
    const powerful = decodeCrystalSave(encodeCrystalSave(editSave(original, catalog, { type: 'overpowered' }, NOW)))
    expect(inspectSave(powerful, catalog)).toMatchObject({ editable: true, levelCap: 99 })
    expect(encodeCrystalSave(powerful)[0]).toBe(252)
    const changed = editSave(original, catalog, { type: 'member', index: 0, jobId: 4 }, NOW)
    expect(inspectSave(changed, catalog).members[0]).toMatchObject({ jobId: 4, growthJobId: 4, subJobId: null })
  })

  it('inspects native IDs and quantities while retaining exact BSON and original bytes', () => {
    const fixture = createSaveEditorFixture()
    const bytes = encodeCrystalSave(fixture)
    const save = decodeCrystalSave(bytes)
    const summary = inspectSave(save, catalog)
    expect(summary.editable).toBe(true)
    expect(summary.currency).toBe(123)
    expect(summary.members[0]).toMatchObject({ name: 'Alex', level: 5, jobId: 0, subJobId: 4, growthJobId: 0 })
    expect(summary.inventory.find(row => row.kind === 'item' && row.id === 0)).toMatchObject({ name: 'Potion', count: 2, capacity: 10 })
    expect(summary.inventory.find(row => row.kind === 'equipment' && row.id === 0)).toMatchObject({ count: 1, equipped: 4, capacity: 95 })
    expect(encodeCrystalSave(save)).toEqual(bytes)
    expect(save.party.value.SyntheticInt64).toEqual({ type: 'int64', value: 9_007_199_254_740_993n })
  })

  it('updates the header with money and names without touching unknown data or source bytes', () => {
    const original = decodeCrystalSave(encodeCrystalSave(createSaveEditorFixture()))
    const old = structuredClone(original)
    const money = editSave(original, catalog, { type: 'currency', value: 456 }, NOW)
    const edited = editSave(money, catalog, { type: 'member', index: 0, name: 'Avery' }, NOW)
    const decoded = decodeCrystalSave(encodeCrystalSave(edited))
    expect(decoded.header.currencyAmount).toBe(456)
    expect(doc(decoded.party.value.Currency).value.Val).toEqual({ type: 'int32', value: 456 })
    expect(decoded.header.members[0]?.name).toBe('Avery')
    expect(decoded.members[0]?.value.Name).toEqual({ type: 'string', value: 'Avery' })
    expect(decoded.party.value.QuestState).toEqual(original.party.value.QuestState)
    expect(decoded.party.value.SyntheticInt64).toEqual(original.party.value.SyntheticInt64)
    expect(decoded.combatBytes).toEqual(original.combatBytes)
    expect(original).toEqual(old)
    expect(previewSaveChanges(original, edited, catalog)).toContain('Member 1: Alex → Avery')
  })

  it('enforces integer money, names, quantities and equipped-inclusive capacity atomically', () => {
    const save = createSaveEditorFixture()
    const old = structuredClone(save)
    for (const value of [-1, 0.5, Number.NaN, SAVE_EDITOR_MAX_CURRENCY + 1]) expect(() => editSave(save, catalog, { type: 'currency', value }, NOW)).toThrow()
    for (const name of ['', ' ', 'Bad\u0000name', 'a'.repeat(33)]) expect(() => editSave(save, catalog, { type: 'member', index: 0, name }, NOW)).toThrow()
    expect(() => editSave(save, catalog, { type: 'stock', kind: 'item', id: 0, count: 11 }, NOW)).toThrow('0 to 10')
    expect(() => editSave(save, catalog, { type: 'stock', kind: 'equipment', id: 0, count: 96 }, NOW)).toThrow('0 to 95')
    expect(() => editSave(save, catalog, { type: 'stock', kind: 'item', id: 90_000, count: 1 }, NOW)).toThrow('Unknown item')
    expect(save).toEqual(old)
  })

  it('accounts for pouches and rejects a removal that would invalidate existing quantities', () => {
    const pouch = editSave(createSaveEditorFixture(), catalog, { type: 'stock', kind: 'item', id: 134, count: 1 }, NOW)
    expect(inspectSave(pouch, catalog).inventory.find(row => row.kind === 'item' && row.id === 0)?.capacity).toBe(12)
    const stocked = editSave(pouch, catalog, { type: 'stock', kind: 'item', id: 0, count: 12 }, NOW)
    expect(() => editSave(stocked, catalog, { type: 'stock', kind: 'item', id: 134, count: 0 }, NOW)).toThrow('0 to 10')
    expect(inspectSave(stocked, catalog).editable).toBe(true)
  })

  it('returns gear to inventory when changing class and preserves passive loadouts', () => {
    const original = createSaveEditorFixture()
    const edited = editSave(original, catalog, { type: 'member', index: 0, jobId: 4 }, NOW)
    expect(edited.header.members[0]?.jobId).toBe(4)
    expect(edited.members[0]?.value.Growth).toEqual({ type: 'int32', value: 4 })
    expect(edited.members[0]?.value.SubJob).toEqual({ type: 'null' })
    expect(arr(edited.members[0]?.value.Equipment).every(value => value.type === 'null')).toBe(true)
    expect(inspectSave(edited, catalog).inventory.find(row => row.kind === 'equipment' && row.id === 0)).toMatchObject({ count: 2, equipped: 3, capacity: 96 })
    expect(edited.members[0]?.value.Passives).toEqual(original.members[0]?.value.Passives)
    expect(() => editSave(original, catalog, { type: 'member', index: 0, jobId: 23 }, NOW)).toThrow('Unlock this class')
    expect(() => editSave(original, catalog, { type: 'member', index: 0, subJobId: 0 }, NOW)).toThrow('must differ')
  })

  it('counts equipment on present members toward the inventory capacity', () => {
    const save = createSaveEditorFixture()
    save.members[3]!.value.IsPresent = { type: 'boolean', value: false }
    save.header.members[3]!.isPresent = false
    const edited = editSave(save, catalog, { type: 'stock', kind: 'equipment', id: 0, count: 96 }, NOW)
    expect(inspectSave(edited, catalog).inventory.find(row => row.kind === 'equipment' && row.id === 0)).toMatchObject({ count: 96, equipped: 3, capacity: 96 })
  })

  it('normalizes redundant passives and automatic abilities after class changes', () => {
    const save = editSave(createSaveEditorFixture(), catalog, { type: 'unlock-jobs' }, NOW)
    const member = save.members[0]!
    const passives = doc(member.value.Passives)
    passives.value.Passives = { type: 'array', value: [{ type: 'int32', value: 2 }] }
    passives.value.CurrentPP = { type: 'int32', value: 9 }
    arr(member.value.LearnedPassives)[2] = { type: 'int32', value: 2 }
    arr(member.value.LearnedAbilities)[28] = { type: 'int32', value: 2 }
    member.value.AutoAbilityID = { type: 'int32', value: 28 }
    const edited = editSave(save, catalog, { type: 'member', index: 0, jobId: 5 }, NOW)
    expect(arr(doc(edited.members[0]?.value.Passives).value.Passives)).toEqual([])
    expect(num(doc(edited.members[0]?.value.Passives).value.CurrentPP)).toBe(10)
    expect(edited.members[0]?.value.AutoAbilityID).toEqual({ type: 'null' })
    expect(previewSaveChanges(save, edited, catalog)).toEqual(expect.arrayContaining(['Alex: redundant passives removed and points returned', 'Alex: unavailable automatic ability cleared']))
    const subclass = editSave(save, catalog, { type: 'member', index: 0, subJobId: 5 }, NOW)
    expect(arr(subclass.members[0]?.value.Equipment).every(value => value.type === 'null')).toBe(true)
    expect(subclass.members[0]?.value.AutoAbilityID).toEqual(member.value.AutoAbilityID)
  })

  it('preserves historical experience and member levels already above an existing assist cap', () => {
    const save = editSave(createSaveEditorFixture(), catalog, { type: 'overpowered' }, NOW)
    doc(save.party.value.GameplayFlags).value.MaxLevelUpVal = { type: 'int32', value: 80 }
    doc(save.members[0]?.value.Levels).value.TotExp = { type: 'int32', value: 1_000_000 }
    const lowered = editSave(save, catalog, { type: 'member', index: 1, level: 70 }, NOW)
    const raised = editSave(lowered, catalog, { type: 'member', index: 1, level: 90 }, NOW)
    expect(num(doc(raised.members[0]?.value.Levels).value.MaxLevel)).toBe(99)
    const preset = editSave(raised, catalog, { type: 'overpowered' }, NOW)
    expect(num(doc(preset.members[0]?.value.Levels).value.TotExp)).toBe(1_000_000)
  })

  it('keeps challenge flags and permits unrelated edits while rejecting forbidden changes', () => {
    const save = createSaveEditorFixture()
    flag(save, 'NoJobChange')
    flag(save, 'NoSubJob')
    flag(save, 'NoAssistOptions')
    expect(editSave(save, catalog, { type: 'member', index: 0, name: 'Avery', jobId: 0, subJobId: 4 }, NOW).header.members[0]?.name).toBe('Avery')
    expect(() => editSave(save, catalog, { type: 'member', index: 0, jobId: 4 }, NOW)).toThrow('challenge')
    expect(() => editSave(save, catalog, { type: 'member', index: 0, subJobId: null }, NOW)).toThrow('challenge')
    expect(() => editSave(save, catalog, { type: 'overpowered' }, NOW)).toThrow('challenge')
    expect(inspectSave(save, catalog).currency).toBe(123)
    flag(save, 'MaxLevelDown')
    doc(save.party.value.GameplayFlags).value.MaxLevelDownVal = { type: 'int32', value: 10 }
    expect(() => editSave(save, catalog, { type: 'member', index: 0, level: 11 }, NOW)).toThrow('challenge')
  })

  it('preserves growth allocation when raising levels and uses native removal order when lowering', () => {
    const save = createSaveEditorFixture()
    const raised = editSave(save, catalog, { type: 'member', index: 0, level: 10 }, NOW)
    const levels = doc(raised.members[0]?.value.Levels)
    expect(num(arr(levels.value.Entries)[0])).toBe(10)
    expect(num(levels.value.TotExp)).toBe(4160)
    expect(num(levels.value.MaxLevel)).toBe(60)
    const mixed = createSaveEditorFixture()
    const mixedLevels = doc(mixed.members[0]?.value.Levels)
    mixedLevels.value.Entries = { type: 'array', value: Array.from({ length: 24 }, (_, id) => ({ type: 'int32', value: id === 0 ? 3 : id === 4 ? 2 : 0 })) }
    mixedLevels.value.Hist = structuredClone(mixedLevels.value.Entries)
    const lowered = editSave(mixed, catalog, { type: 'member', index: 0, level: 3 }, NOW)
    expect(arr(doc(lowered.members[0]?.value.Levels).value.Entries).slice(0, 5).map(num)).toEqual([3, 0, 0, 0, 0])
    expect(arr(doc(lowered.members[0]?.value.Levels).value.Hist).slice(0, 5).map(num)).toEqual([3, 0, 0, 0, 2])
  })

  it('applies a bounded overpowered preset without changing world events or equipped builds', () => {
    const save = createSaveEditorFixture()
    const edited = editSave(save, catalog, { type: 'overpowered' }, NOW)
    const summary = inspectSave(edited, catalog)
    expect(summary.editable).toBe(true)
    expect(summary.currency).toBe(SAVE_EDITOR_MAX_CURRENCY)
    expect(summary.levelCap).toBe(99)
    expect(edited.header.assistFlags & 128).toBe(128)
    for (const [index, member] of summary.members.entries()) {
      expect(member).toMatchObject({ level: 99, unlockedJobs: 24, masteredJobs: 24, learnedAbilities: 253, learnedPassives: 60 })
      expect(edited.members[index]?.value.Equipment).toEqual(save.members[index]?.value.Equipment)
      expect(edited.members[index]?.value.Passives).toEqual(save.members[index]?.value.Passives)
      expect(num(doc(edited.members[index]?.value.Levels).value.TotExp)).toBe(759510)
    }
    expect(summary.inventory.find(row => row.kind === 'item' && row.id === 0)).toMatchObject({ count: 99, capacity: 99 })
    expect(summary.inventory.find(row => row.kind === 'equipment' && row.id === 0)).toMatchObject({ count: 6, equipped: 4 })
    expect(summary.inventory.find(row => row.kind === 'equipment' && row.id === 135)?.count).toBe(10)
    expect(summary.inventory.filter(row => /test|placeholder|debug|unused/i.test(row.name))).toEqual([])
    expect(edited.maps).toEqual(save.maps)
    for (const key of ['QuestState', 'EntityVariables', 'History', 'Mods', 'SyntheticInt64']) expect(edited.party.value[key]).toEqual(save.party.value[key])
    expect(encodeCrystalSave(decodeCrystalSave(encodeCrystalSave(edited)))).toEqual(encodeCrystalSave(edited))
  })

  it('distinguishes unlocking from mastery and preserves innate-only passive state', () => {
    const save = createSaveEditorFixture()
    const unlocked = editSave(save, catalog, { type: 'unlock-jobs' }, NOW)
    expect(inspectSave(unlocked, catalog).members[0]).toMatchObject({ unlockedJobs: 24, masteredJobs: 0 })
    const mastered = editSave(unlocked, catalog, { type: 'master-jobs' }, NOW)
    const innate = [...catalog.records.passive].find(([, passive]) => passive.IsInnate && !passive.IsLearnable)!
    expect(num(arr(mastered.members[0]?.value.LearnedPassives)[innate[0]])).toBeLessThan(2)
    doc(mastered.members[0]?.value.JP).value.TotalJP = { type: 'int32', value: 500_000 }
    const firstJp = doc(arr(doc(mastered.members[0]?.value.JP).value.Entries)[0])
    firstJp.value.Current = { type: 'int32', value: 0 }
    const again = editSave(mastered, catalog, { type: 'master-jobs' }, NOW)
    expect(previewSaveChanges(mastered, again, catalog)).toContain('Alex: class JP updated')
    expect(num(doc(again.members[0]?.value.JP).value.TotalJP)).toBe(500_000)
    arr(unlocked.members[0]?.value.LearnedAbilities)[2] = { type: 'int32', value: 0 }
    const restoredUnlock = editSave(unlocked, catalog, { type: 'unlock-jobs' }, NOW)
    expect(previewSaveChanges(unlocked, restoredUnlock, catalog)).toContain('Alex: ability and passive unlock states updated')
  })

  it('reveals existing map bits only, masking unused final bits and preserving origin', () => {
    const save = createSaveEditorFixture()
    const edited = editSave(save, catalog, { type: 'reveal-maps' }, NOW)
    expect(edited.maps).toEqual([{ id: 1, originX: -3, originY: 7, lengthX: 3, lengthY: 3, data: new Uint8Array([255, 1]) }])
    expect(previewSaveChanges(save, edited, catalog)).toEqual(['1 stored maps revealed'])
    expect(save.maps[0]?.data).toEqual(new Uint8Array([1, 0]))
  })

  it('keeps unsupported configurations and unknown IDs read-only', () => {
    const cases = [
      (save: CrystalSave) => { save.header.isModded = true },
      (save: CrystalSave) => { save.header.patchMode = 1 },
      (save: CrystalSave) => { doc(save.party.value.RandomizerFlags).value.Crystals = { type: 'boolean', value: true } },
      (save: CrystalSave) => { save.header.currencyAmount++ },
      (save: CrystalSave) => { arr(doc(save.party.value.Items).value.Stock).push({ type: 'document', value: { Item: { type: 'int32', value: 90_000 }, Count: { type: 'int32', value: 1 } } }) },
      (save: CrystalSave) => { arr(doc(save.members[0]?.value.Passives).value.Passives).push({ type: 'int32', value: 90_000 }) },
      (save: CrystalSave) => { doc(save.members[0]?.value.Passives).value.CurrentPP = { type: 'int32', value: 8 } },
      (save: CrystalSave) => { arr(doc(save.members[0]?.value.Levels).value.Entries)[0] = { type: 'int32', value: 4 } },
      (save: CrystalSave) => { flag(save, 'NoAssistOptions'); flag(save, 'MaxLevelUp'); doc(save.party.value.GameplayFlags).value.MaxLevelUpVal = { type: 'int32', value: 99 }; save.header.assistFlags |= 128 },
      (save: CrystalSave) => { flag(save, 'MaxLevelUp'); doc(save.party.value.GameplayFlags).value.MaxLevelUpVal = { type: 'int32', value: 59 }; save.header.assistFlags |= 128 },
      (save: CrystalSave) => { save.header.assistFlags |= 128 },
    ]
    for (const mutate of cases) {
      const save = createSaveEditorFixture()
      mutate(save)
      expect(inspectSave(save, catalog).editable).toBe(false)
      expect(() => editSave(save, catalog, { type: 'currency', value: 456 }, NOW)).toThrow()
    }
  })
})
