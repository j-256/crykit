import { describe, expect, it } from 'vitest'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { decodeCrystalSave, encodeCrystalSave, type BsonDocument, type BsonValue, type CrystalSave } from '../interchange/crystal-save'
import { createModdedSaveEditorFixture, createNeutralSaveEditorFixture, createSaveEditorFixture, createSaveEditorModSourceFixture, setSaveEditorFixtureMode, setSaveEditorFixtureRandomizer, SYNTHETIC_SAVE_MOD } from './save-editor.fixture'
import { editSave, inspectSave, previewSaveChanges, previewVanillaConversion, SAVE_EDITOR_MAX_CURRENCY } from './save-editor'
import { resolveSaveEditorMods } from './save-editor-mods'

const NOW = new Date('2026-01-02T03:04:05Z')
const catalog = SAVE_EDITOR_CATALOG
const LEVEL_CAP_ASSIST_FLAG = 128
const UNMATCHED_JOB_ID = 24
const NATIVE_PASSIVE_COUNT = 88
const RESIDUAL_JOB_COUNT = 25
const RESIDUAL_PASSIVE_COUNT = 112
const UNMATCHED_PASSIVE_ID = RESIDUAL_PASSIVE_COUNT - 1
const UNMATCHED_ABILITY_ID = 508
const UNMATCHED_EQUIPMENT_ID = 90_000
const UNRESOLVED_JP_JOB_ID = -1
const NEUTRAL_JP_IDENTITIES = [
  ['unmatched job', { type: 'int32', value: UNMATCHED_JOB_ID }],
  ['removed job sentinel', { type: 'int32', value: UNRESOLVED_JP_JOB_ID }],
  ['null job reference', { type: 'null' }],
] satisfies readonly (readonly [string, BsonValue])[]
const MAX_JP = 10_000
const POTION_ID = 0
const POTION_POUCH_ID = 134
const ETHER_POUCH_ID = 136
const TONIC_POUCH_ID = 133
const SPAWNING_MEADOWS_MAP_ID = 73
const CONTRACT_SWORD_ID = 71
function doc(value: BsonValue | undefined): BsonDocument { if (value?.type !== 'document') throw new Error('Expected document'); return value }
function arr(value: BsonValue | undefined): BsonValue[] { if (value?.type !== 'array') throw new Error('Expected array'); return value.value }
function num(value: BsonValue | undefined): number { if (value?.type !== 'int32') throw new Error('Expected integer'); return value.value }
function flag(save: CrystalSave, key: string): void { doc(save.party.value.GameplayFlags).value[key] = { type: 'boolean', value: true } }
function swap(length: number, left: number, right: number): number[] { const values = Array.from({ length }, (_, id) => id); [values[left], values[right]] = [values[right]!, values[left]!]; return values }

function neutralJobResidueFixture(job: BsonValue = { type: 'int32', value: UNMATCHED_JOB_ID }): CrystalSave {
  if (job.type === 'null') return createNeutralSaveEditorFixture(null)
  if (job.type === 'int32') return createNeutralSaveEditorFixture(job.value)
  throw new Error('Synthetic orphan JP identity must be an integer or null')
}

function residueJp(save: CrystalSave): BsonDocument {
  return doc(arr(doc(save.members[0]!.value.JP).value.Entries).at(-1))
}

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
    const named = editSave(original, catalog, { type: 'member', index: 0, name: 'Legacy Hero', level: 5, subJobId: null }, NOW)
    expect(named.party).toEqual(original.party)
    expect(named.members[0]!.value.Levels).toEqual(original.members[0]!.value.Levels)
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

  it.each(NEUTRAL_JP_IDENTITIES)('retains neutral %s residues through ordinary edits and encoded round-trips', (_label, job) => {
    expect(catalog.records.job.has(UNMATCHED_JOB_ID)).toBe(false)
    const bytes = encodeCrystalSave(neutralJobResidueFixture(job))
    const original = decodeCrystalSave(bytes)
    const before = structuredClone(original)
    expect(original.header).toMatchObject({ isModded: false, mods: [], modIdMaps: [] })
    expect(inspectSave(original, catalog)).toMatchObject({ editable: true, issues: [], randomized: false })
    expect(residueJp(original).value.Job).toEqual(job)
    const mapping = doc(original.party.value.RandomizerMapping)
    expect(arr(mapping.value.Jobs).map(num)).toEqual(Array.from({ length: RESIDUAL_JOB_COUNT }, (_, id) => id))
    expect(arr(mapping.value.Passives).map(num)).toEqual(Array.from({ length: RESIDUAL_PASSIVE_COUNT }, (_, id) => id))
    expect(arr(doc(doc(original.party.value.Atlas).value.Jobs).value.Entries)).toHaveLength(RESIDUAL_JOB_COUNT)
    expect(arr(doc(doc(original.party.value.Atlas).value.Passives).value.Entries)).toHaveLength(RESIDUAL_PASSIVE_COUNT)
    for (const member of original.members) {
      for (const field of ['Entries', 'Hist']) {
        const values = arr(doc(member.value.Levels).value[field])
        expect(values).toHaveLength(RESIDUAL_JOB_COUNT)
        expect(values.slice(UNMATCHED_JOB_ID).map(num)).toEqual([0])
      }
      expect(arr(member.value.LearnedJobs)).toHaveLength(RESIDUAL_JOB_COUNT)
      expect(arr(member.value.LearnedJobs).slice(UNMATCHED_JOB_ID).map(num)).toEqual([0])
      expect(arr(member.value.LearnedPassives)).toHaveLength(RESIDUAL_PASSIVE_COUNT)
      expect(arr(member.value.LearnedPassives).slice(NATIVE_PASSIVE_COUNT).map(num)).toEqual(Array<number>(RESIDUAL_PASSIVE_COUNT - NATIVE_PASSIVE_COUNT).fill(0))
      const entries = arr(doc(member.value.JP).value.Entries)
      expect(entries).toHaveLength(RESIDUAL_JOB_COUNT)
      const orphan = doc(entries.at(-1))
      expect(Object.hasOwn(orphan.value, 'Job')).toBe(true)
      expect(orphan.value.Job).toEqual(job)
    }
    const money = editSave(original, catalog, { type: 'currency', value: 456 }, NOW)
    expect(money.members).toEqual(original.members)
    const edited = editSave(money, catalog, { type: 'member', index: 0, name: 'Avery', level: 10 }, NOW)
    expect(inspectSave(edited, catalog)).toMatchObject({ editable: true, issues: [], currency: 456, members: [{ name: 'Avery', level: 10 }, {}, {}, {}] })
    const editedBytes = encodeCrystalSave(edited)
    const roundTrip = decodeCrystalSave(editedBytes)
    expect(inspectSave(roundTrip, catalog)).toMatchObject({ editable: true, issues: [] })
    expect(residueJp(roundTrip).value.Job).toEqual(job)
    for (const candidate of [money, edited, roundTrip]) {
      expect(candidate.party.value.RandomizerMapping).toEqual(original.party.value.RandomizerMapping)
      expect(candidate.party.value.Atlas).toEqual(original.party.value.Atlas)
      for (const [index, member] of candidate.members.entries()) {
        const source = original.members[index]!
        expect(member.value.JP).toEqual(source.value.JP)
        for (const field of ['LearnedJobs', 'LearnedAbilities', 'LearnedPassives']) expect(member.value[field]).toEqual(source.value[field])
        for (const field of ['Entries', 'Hist']) expect(arr(doc(member.value.Levels).value[field]).slice(UNMATCHED_JOB_ID)).toEqual(arr(doc(source.value.Levels).value[field]).slice(UNMATCHED_JOB_ID))
        expect(Object.hasOwn(doc(arr(doc(member.value.JP).value.Entries).at(-1)).value, 'Job')).toBe(true)
      }
    }
    expect(encodeCrystalSave(roundTrip)).toEqual(editedBytes)
    expect(edited.originalBytes).toEqual(bytes)
    expect(original).toEqual(before)
    expect(original.originalBytes).toEqual(bytes)
    expect(encodeCrystalSave(original)).toEqual(bytes)
  })

  it('preserves known historical growth above the current allocation through ordinary edits', () => {
    const fixture = neutralJobResidueFixture()
    const history = arr(doc(fixture.members[0]!.value.Levels).value.Hist)
    history[0] = { type: 'int32', value: 7 }
    history[4] = { type: 'int32', value: 3 }
    const bytes = encodeCrystalSave(fixture)
    const original = decodeCrystalSave(bytes)
    const before = structuredClone(original)
    expect(inspectSave(original, catalog)).toMatchObject({ editable: true, issues: [] })
    const money = editSave(original, catalog, { type: 'currency', value: 456 }, NOW)
    const named = editSave(money, catalog, { type: 'member', index: 0, name: 'Avery' }, NOW)
    const editedBytes = encodeCrystalSave(named)
    const roundTrip = decodeCrystalSave(editedBytes)
    expect(inspectSave(roundTrip, catalog)).toMatchObject({ editable: true, currency: 456, members: [{ name: 'Avery', level: 5 }, {}, {}, {}] })
    for (const [index, member] of roundTrip.members.entries()) expect(member.value.Levels).toEqual(original.members[index]!.value.Levels)
    expect(encodeCrystalSave(roundTrip)).toEqual(editedBytes)
    expect(named.originalBytes).toEqual(bytes)
    expect(original).toEqual(before)
    expect(encodeCrystalSave(original)).toEqual(bytes)
  })

  it.each([
    ['historical growth', `Unknown job ID ${UNMATCHED_JOB_ID}`, (save: CrystalSave) => { arr(doc(save.members[0]!.value.Levels).value.Hist)[UNMATCHED_JOB_ID] = { type: 'int32', value: 1 } }],
    ['current growth', `Unknown job ID ${UNMATCHED_JOB_ID}`, (save: CrystalSave) => {
      const levels = doc(save.members[0]!.value.Levels)
      arr(levels.value.Entries)[0] = { type: 'int32', value: 4 }
      arr(levels.value.Entries)[UNMATCHED_JOB_ID] = { type: 'int32', value: 1 }
      arr(levels.value.Hist)[UNMATCHED_JOB_ID] = { type: 'int32', value: 1 }
    }],
    ['class learning', `Unknown job ID ${UNMATCHED_JOB_ID}`, (save: CrystalSave) => { arr(save.members[0]!.value.LearnedJobs)[UNMATCHED_JOB_ID] = { type: 'int32', value: 1 } }],
    ['ability learning', `Unknown ability ID ${UNMATCHED_ABILITY_ID}`, (save: CrystalSave) => { arr(save.members[0]!.value.LearnedAbilities).push({ type: 'int32', value: 1 }) }],
    ['first residual passive learning', `Unknown passive ID ${NATIVE_PASSIVE_COUNT}`, (save: CrystalSave) => { arr(save.members[0]!.value.LearnedPassives)[NATIVE_PASSIVE_COUNT] = { type: 'int32', value: 2 } }],
    ['last residual passive learning', `Unknown passive ID ${UNMATCHED_PASSIVE_ID}`, (save: CrystalSave) => { arr(save.members[0]!.value.LearnedPassives)[UNMATCHED_PASSIVE_ID] = { type: 'int32', value: 2 } }],
    ['equipped passive', `Unknown passive ID ${UNMATCHED_PASSIVE_ID}`, (save: CrystalSave) => { arr(doc(save.members[0]!.value.Passives).value.Passives).push({ type: 'int32', value: UNMATCHED_PASSIVE_ID }) }],
    ['equipped equipment', `Unknown equipment ID ${UNMATCHED_EQUIPMENT_ID}`, (save: CrystalSave) => { arr(save.members[0]!.value.Equipment)[0] = { type: 'int32', value: UNMATCHED_EQUIPMENT_ID } }],
  ] satisfies readonly (readonly [string, string, (save: CrystalSave) => void])[])('rejects meaningful unknown %s without changing source state or bytes', (_label, diagnostic, mutate) => {
    const fixture = neutralJobResidueFixture()
    mutate(fixture)
    const bytes = encodeCrystalSave(fixture)
    const original = decodeCrystalSave(bytes)
    const before = structuredClone(original)
    expect(inspectSave(original, catalog)).toMatchObject({ editable: false, issues: [expect.stringContaining(diagnostic)] })
    expect(() => editSave(original, catalog, { type: 'member', index: 0, name: 'Avery', level: 10 }, NOW)).toThrow(diagnostic)
    expect(original).toEqual(before)
    expect(original.originalBytes).toEqual(bytes)
    expect(encodeCrystalSave(original)).toEqual(bytes)
  })

  it.each(NEUTRAL_JP_IDENTITIES.flatMap(([label, job]) => [['Current', label, job], ['Total', label, job]] as const))('keeps positive %s JP for %s read-only', (field, _label, job) => {
    const save = neutralJobResidueFixture(job)
    residueJp(save).value[field] = { type: 'int32', value: 1 }
    const before = structuredClone(save)
    const bytes = encodeCrystalSave(save)
    const diagnosticId = job.type === 'int32' ? job.value : UNRESOLVED_JP_JOB_ID
    expect(inspectSave(save, catalog)).toMatchObject({ editable: false, issues: [expect.stringContaining(`Unknown job ID ${diagnosticId}`)] })
    expect(() => editSave(save, catalog, { type: 'currency', value: 456 }, NOW)).toThrow(`Unknown job ID ${diagnosticId}`)
    expect(save).toEqual(before)
    expect(encodeCrystalSave(save)).toEqual(bytes)
  })

  it.each([
    ['Current', { type: 'int32', value: -1 }],
    ['Current', { type: 'int32', value: MAX_JP + 1 }],
    ['Current', { type: 'double', value: 0.5 }],
    ['Current', { type: 'string', value: '0' }],
    ['Current', undefined],
    ['Total', { type: 'int32', value: -1 }],
    ['Total', { type: 'int32', value: MAX_JP + 1 }],
    ['Total', { type: 'double', value: 0.5 }],
    ['Total', { type: 'string', value: '0' }],
    ['Total', undefined],
    ['Job', { type: 'int32', value: -2 }],
    ['Job', { type: 'double', value: 2_147_483_648 }],
    ['Job', { type: 'double', value: 0.5 }],
    ['Job', { type: 'string', value: '24' }],
    ['Job', undefined],
  ] satisfies readonly (readonly [string, BsonValue | undefined])[])('rejects malformed neutral-residue %s value %j', (field, value) => {
    const save = neutralJobResidueFixture()
    const jp = residueJp(save)
    if (value === undefined) delete jp.value[field]
    else jp.value[field] = value
    const before = structuredClone(save)
    expect(inspectSave(save, catalog).editable).toBe(false)
    expect(() => editSave(save, catalog, { type: 'member', index: 0, name: 'Avery' }, NOW)).toThrow()
    expect(save).toEqual(before)
  })

  it.each([[1, 'Vanilla'], [2, 'Chaos']] as const)('edits nonrandomized %s mode saves with their native patch definitions', (patchMode, name) => {
    const original = setSaveEditorFixtureMode(createSaveEditorFixture(), patchMode)
    expect(inspectSave(original, catalog)).toMatchObject({ editable: true, mode: { value: patchMode, name } })
    const edited = editSave(original, catalog, { type: 'currency', value: 456 }, NOW)
    expect(inspectSave(edited, catalog)).toMatchObject({ editable: true, currency: 456, mode: { value: patchMode, name } })
    expect(edited.header.patchMode).toBe(patchMode)
    expect(doc(edited.party.value.GameplayFlags).value.PatchMode).toEqual({ type: 'int32', value: patchMode })
  })

  it('overlays Vanilla and Chaos records before validating save and mod state', () => {
    const vanilla = resolveSaveEditorMods(setSaveEditorFixtureMode(createSaveEditorFixture(), 1), catalog).catalog
    const chaos = resolveSaveEditorMods(setSaveEditorFixtureMode(createSaveEditorFixture(), 2), catalog).catalog
    expect(catalog.records.passive.get(74)?.PP).toBe(8)
    expect(vanilla.records.passive.get(74)?.PP).toBe(0)
    expect(catalog.records.ability.get(13)?.BasePower).toBe(400)
    expect(chaos.records.ability.get(13)?.BasePower).toBe(10_000)
    expect(catalog.randomizerRecords.monster.get(1)?.NoAuto).toBe(false)
    expect(chaos.randomizerRecords.monster.get(1)?.NoAuto).toBe(true)

    const modded = setSaveEditorFixtureMode(createModdedSaveEditorFixture(), 1)
    expect(inspectSave(modded, catalog, [createSaveEditorModSourceFixture()])).toMatchObject({ editable: true, mode: { name: 'Vanilla' } })
  })

  it.each([[0, 'Standard'], [1, 'Vanilla'], [2, 'Chaos']] as const)('edits randomized %s mode saves without changing their seed or mappings', (patchMode, name) => {
    const save = setSaveEditorFixtureRandomizer(setSaveEditorFixtureMode(createSaveEditorFixture(), patchMode), { flags: { Equipment: true }, mappings: { Equipment: swap(591, 0, 381) } })
    const originalFlags = structuredClone(save.party.value.RandomizerFlags)
    const originalMapping = structuredClone(save.party.value.RandomizerMapping)
    expect(inspectSave(save, catalog)).toMatchObject({ editable: true, randomized: true, mode: { value: patchMode, name } })
    const edited = editSave(save, catalog, { type: 'currency', value: 456 }, NOW)
    expect(inspectSave(edited, catalog)).toMatchObject({ editable: true, randomized: true, currency: 456, mode: { value: patchMode, name } })
    expect(edited.party.value.RandomizerFlags).toEqual(originalFlags)
    expect(edited.party.value.RandomizerMapping).toEqual(originalMapping)
  })

  it('uses randomized abilities and innate passives for class and loadout rules', () => {
    const save = setSaveEditorFixtureRandomizer(createSaveEditorFixture(), {
      flags: { JobAbilities: true, InnatePassives: true },
      mappings: { AbilityJobs: swap(508, 28, 344), Passives: swap(88, 50, 72) },
    })
    arr(save.members[0]!.value.LearnedAbilities)[344] = { type: 'int32', value: 2 }
    save.members[0]!.value.AutoAbilityID = { type: 'int32', value: 344 }
    const changedClass = editSave(save, catalog, { type: 'member', index: 0, subJobId: null }, NOW)
    expect(changedClass.members[0]!.value.AutoAbilityID).toEqual({ type: 'int32', value: 344 })
    const loadout = editSave(save, catalog, { type: 'loadout', index: 0, jobId: 0, subJobId: 4, equipmentIds: [0, 0, null, null, null, null], passiveIds: [] }, NOW)
    expect(arr(loadout.members[0]!.value.Equipment).slice(0, 2).map(num)).toEqual([0, 0])
  })

  it('rejects inconsistent or malformed randomizer state', () => {
    const mismatch = setSaveEditorFixtureRandomizer(createSaveEditorFixture(), { flags: { Equipment: true } })
    mismatch.header.randomizerFlags = 0
    expect(inspectSave(mismatch, catalog).issues).toContain('Header and party randomizer flags disagree')

    const duplicate = Array.from({ length: 508 }, (_, id) => id)
    duplicate[2] = 3
    const invalid = setSaveEditorFixtureRandomizer(createSaveEditorFixture(), { flags: { JobAbilities: true }, mappings: { AbilityJobs: duplicate } })
    expect(inspectSave(invalid, catalog).issues).toContain('Job ability randomizer mapping targets ID 3 more than once')

    const incomplete = setSaveEditorFixtureRandomizer(createSaveEditorFixture(), { flags: { Crystals: true }, mappings: { Jobs: Array.from({ length: 23 }, (_, id) => id) } })
    expect(inspectSave(incomplete, catalog).issues).toContain('Class randomizer mapping has 23 entries; expected 24')
  })

  it('allows non-mapping randomizer options without requiring identity tables', () => {
    const save = setSaveEditorFixtureRandomizer(createSaveEditorFixture(), { flags: { StartWithAllMaps: true } })
    delete save.party.value.RandomizerMapping
    expect(inspectSave(save, catalog)).toMatchObject({ editable: true, randomized: true })
    expect(editSave(save, catalog, { type: 'currency', value: 456 }, NOW).header.currencyAmount).toBe(456)
  })

  it('applies randomizer mappings after exact active mod redirects', () => {
    const save = setSaveEditorFixtureRandomizer(createModdedSaveEditorFixture({ relocated: true }), { flags: { InnatePassives: true } })
    const source = createSaveEditorModSourceFixture()
    expect(inspectSave(save, catalog, [source])).toMatchObject({ editable: true, randomized: true })
    const edited = editSave(save, catalog, { type: 'currency', value: 456 }, NOW, [source])
    expect(inspectSave(edited, catalog, [source])).toMatchObject({ editable: true, randomized: true, currency: 456 })
    expect(edited.party.value.RandomizerMapping).toEqual(save.party.value.RandomizerMapping)
  })

  it('edits an active mod save only with an exact matching source', () => {
    const save = createModdedSaveEditorFixture({ equipped: true })
    const source = createSaveEditorModSourceFixture()
    expect(inspectSave(save, catalog)).toMatchObject({ editable: false, issues: [`Add the exact ${SYNTHETIC_SAVE_MOD.title} ${SYNTHETIC_SAVE_MOD.version} Crystal Edit JSON to edit this save`] })
    expect(inspectSave(save, catalog, [{ ...source, version: '2.0' }]).editable).toBe(false)
    expect(inspectSave(save, catalog, [source])).toMatchObject({ editable: true, members: [{ learnedPassives: 2 }, {}, {}, {}] })
    const edited = editSave(save, catalog, { type: 'currency', value: 456 }, NOW, [source])
    expect(inspectSave(edited, catalog, [source])).toMatchObject({ editable: true, currency: 456 })
    expect(save.header.currencyAmount).toBe(123)
  })

  it('does not match a declared mod revision with the wrong Workshop identity', () => {
    const save = createModdedSaveEditorFixture({ mod: { ...SYNTHETIC_SAVE_MOD, steamWorkshopFileId: '1234' } })
    const source = createSaveEditorModSourceFixture()
    const resolution = resolveSaveEditorMods(save, catalog, [source])
    expect(resolution.activeMods[0]).toMatchObject({ matched: false })
    expect(resolution.issues).toContain(`${SYNTHETIC_SAVE_MOD.title}: Steam Workshop identity does not match the save`)
    expect(inspectSave(save, catalog, [source]).editable).toBe(false)
  })

  it('applies non-identity O/N redirects to imported definitions', () => {
    const save = createModdedSaveEditorFixture({ relocated: true, equipped: true })
    const source = createSaveEditorModSourceFixture()
    const resolution = resolveSaveEditorMods(save, catalog, [source])
    expect(resolution.issues).toEqual([])
    expect(resolution.catalog.records.job.has(24)).toBe(false)
    expect(resolution.catalog.records.job.get(27)?.ID).toBe(27)
    expect(resolution.catalog.records.passive.get(188)?.ID).toBe(188)
    expect(resolution.catalog.records.passive.get(211)?.ID).toBe(211)
    expect(resolution.catalog.records.job.get(27)?.PassiveIDs).toEqual([188, 211])
    expect(inspectSave(save, catalog, [source]).editable).toBe(true)
  })

  it('restores native values for in-place overrides when mod metadata is cleared', () => {
    const save = createModdedSaveEditorFixture()
    const source = createSaveEditorModSourceFixture()
    const native = catalog.records.passive.get(0)!
    const passives = new Map(source.records.passive)
    passives.set(0, { ...native, Name: 'Synthetic override' })
    const overridden = { ...source, records: { ...source.records, passive: passives } }
    const active = resolveSaveEditorMods(save, catalog, [overridden])
    expect(active.issues).toEqual([])
    expect(active.catalog.records.passive.get(0)?.Name).toBe('Synthetic override')
    const conversion = previewVanillaConversion(save, catalog)
    expect(conversion.convertible).toBe(true)
    expect(resolveSaveEditorMods(conversion.draft!, catalog).catalog.records.passive.get(0)?.Name).toBe(native.Name)
  })

  it('previews and applies complete supported mod-state removal', () => {
    const original = createModdedSaveEditorFixture({ equipped: true })
    const preview = previewVanillaConversion(original, catalog)
    expect(preview).toMatchObject({ relevant: true, convertible: true, blockers: [] })
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.stringContaining('equipped mod-only passives removed'),
      expect.stringContaining('mod-only learning entries removed'),
      'Saved mod flags, active list, and ID redirects cleared',
    ]))
    const converted = preview.draft!
    expect(converted.header).toMatchObject({ isModded: false, mods: [], modIdMaps: [] })
    expect(arr(converted.members[0]!.value.LearnedJobs)).toHaveLength(24)
    expect(arr(converted.members[0]!.value.LearnedPassives)).toHaveLength(88)
    expect(arr(doc(converted.members[0]!.value.Passives).value.Passives)).toEqual([])
    expect(inspectSave(converted, catalog)).toMatchObject({ editable: true, members: [{ learnedPassives: 0 }, {}, {}, {}] })
    expect(decodeCrystalSave(encodeCrystalSave(converted))).toMatchObject({ header: { isModded: false, mods: [], modIdMaps: [] } })
    expect(original.header.isModded).toBe(true)
  })

  it.each([[1, 'Vanilla'], [2, 'Chaos']] as const)('converts supported mod residue without changing %s mode', (patchMode, name) => {
    const original = setSaveEditorFixtureMode(createModdedSaveEditorFixture({ active: false }), patchMode)
    const preview = previewVanillaConversion(original, catalog)
    expect(preview).toMatchObject({ relevant: true, convertible: true, blockers: [] })
    expect(preview.draft?.header.patchMode).toBe(patchMode)
    expect(inspectSave(preview.draft!, catalog)).toMatchObject({ editable: true, mode: { name } })
  })

  it('normalizes unflagged residual identity tails without requiring a mod source', () => {
    const residual = createModdedSaveEditorFixture({ active: false, unflagged: true })
    for (const member of residual.members) {
      arr(member.value.LearnedJobs).slice(24).forEach(value => { if (value.type === 'int32') value.value = 0 })
      arr(member.value.LearnedPassives).slice(88).forEach(value => { if (value.type === 'int32') value.value = 0 })
    }
    expect(inspectSave(residual, catalog)).toMatchObject({ editable: true, issues: [] })
    const preview = previewVanillaConversion(residual, catalog)
    expect(preview).toMatchObject({ relevant: true, convertible: true, blockers: [] })
    expect(preview.draft!.header.isModded).toBe(false)
    expect(arr(preview.draft!.members[0]!.value.LearnedJobs)).toHaveLength(24)
    expect(arr(preview.draft!.members[0]!.value.LearnedPassives)).toHaveLength(88)
    expect(inspectSave(preview.draft!, catalog).editable).toBe(true)
  })

  it('refuses to guess a native replacement for an active mod-only class', () => {
    const save = createModdedSaveEditorFixture()
    save.members[0]!.value.Job = { type: 'int32', value: 24 }
    save.members[0]!.value.Growth = { type: 'int32', value: 24 }
    save.header.members[0]!.jobId = 24
    const preview = previewVanillaConversion(save, catalog)
    expect(preview).toMatchObject({ relevant: true, convertible: false })
    expect(preview.blockers).toEqual(expect.arrayContaining(['Alex uses mod-only current class 24', 'Alex uses mod-only growth class 24']))
    expect(preview.draft).toBeUndefined()
  })

  it('does not present an unmodded randomizer save as a mod-state removal candidate', () => {
    const save = setSaveEditorFixtureRandomizer(createSaveEditorFixture(), { flags: { Equipment: true } })
    expect(previewVanillaConversion(save, catalog)).toEqual({ relevant: false, convertible: false, changes: [], blockers: [] })
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

  it('adds quantities from every matching pouch while ignoring pouches for other items', () => {
    const source = createSaveEditorModSourceFixture()
    const items = new Map(source.records.item)
    items.set(ETHER_POUCH_ID, { ...catalog.records.item.get(ETHER_POUCH_ID)!, IncreaseMaxCapacityForItemID: POTION_ID, IncreaseMaxCapacityBy: 3 })
    const sources = [{ ...source, records: { ...source.records, item: items } }]
    let save = createModdedSaveEditorFixture()
    save = editSave(save, catalog, { type: 'stock', kind: 'item', id: POTION_POUCH_ID, count: 2 }, NOW, sources)
    save = editSave(save, catalog, { type: 'stock', kind: 'item', id: ETHER_POUCH_ID, count: 3 }, NOW, sources)
    save = editSave(save, catalog, { type: 'stock', kind: 'item', id: TONIC_POUCH_ID, count: 4 }, NOW, sources)
    expect(inspectSave(save, catalog, sources).inventory.find(row => row.kind === 'item' && row.id === POTION_ID)).toMatchObject({ capacity: 23 })
    const stocked = editSave(save, catalog, { type: 'stock', kind: 'item', id: POTION_ID, count: 23 }, NOW, sources)
    const before = structuredClone(stocked)
    const bytes = encodeCrystalSave(stocked)
    expect(() => editSave(stocked, catalog, { type: 'stock', kind: 'item', id: POTION_ID, count: 24 }, NOW, sources)).toThrow('0 to 23')
    expect(() => editSave(stocked, catalog, { type: 'stock', kind: 'item', id: ETHER_POUCH_ID, count: 2 }, NOW, sources)).toThrow('0 to 20')
    expect(stocked).toEqual(before)
    expect(encodeCrystalSave(stocked)).toEqual(bytes)
    const expanded = editSave(stocked, catalog, { type: 'stock', kind: 'item', id: POTION_POUCH_ID, count: 3 }, NOW, sources)
    expect(inspectSave(expanded, catalog, sources).inventory.find(row => row.kind === 'item' && row.id === POTION_ID)).toMatchObject({ count: 23, capacity: 25 })
  })

  it('clamps positive-base pouch capacity at 99 and validates reductions atomically', () => {
    const pouches = editSave(createSaveEditorFixture(), catalog, { type: 'stock', kind: 'item', id: POTION_POUCH_ID, count: 45 }, NOW)
    expect(inspectSave(pouches, catalog).inventory.find(row => row.kind === 'item' && row.id === POTION_ID)).toMatchObject({ capacity: 99 })
    const stocked = editSave(pouches, catalog, { type: 'stock', kind: 'item', id: POTION_ID, count: 99 }, NOW)
    const before = structuredClone(stocked)
    const bytes = encodeCrystalSave(stocked)
    expect(() => editSave(stocked, catalog, { type: 'stock', kind: 'item', id: POTION_ID, count: 100 }, NOW)).toThrow('0 to 99')
    expect(() => editSave(stocked, catalog, { type: 'stock', kind: 'item', id: POTION_POUCH_ID, count: 44 }, NOW)).toThrow('0 to 98')
    expect(stocked).toEqual(before)
    expect(encodeCrystalSave(stocked)).toEqual(bytes)
    const reduced = editSave(editSave(stocked, catalog, { type: 'stock', kind: 'item', id: POTION_ID, count: 98 }, NOW), catalog, { type: 'stock', kind: 'item', id: POTION_POUCH_ID, count: 44 }, NOW)
    expect(inspectSave(reduced, catalog).inventory.find(row => row.kind === 'item' && row.id === POTION_ID)).toMatchObject({ count: 98, capacity: 98 })
  })

  it('uses zero-base capacity defaults for maps and other items before considering pouch bonuses', () => {
    expect(catalog.records.item.get(POTION_POUCH_ID)).toMatchObject({ MaxCapacity: 0, MapForBiomeID: null })
    expect(catalog.records.item.get(SPAWNING_MEADOWS_MAP_ID)).toMatchObject({ MaxCapacity: 0, MapForBiomeID: 1 })
    const source = createSaveEditorModSourceFixture()
    const items = new Map(source.records.item)
    items.set(ETHER_POUCH_ID, { ...catalog.records.item.get(ETHER_POUCH_ID)!, IncreaseMaxCapacityForItemID: SPAWNING_MEADOWS_MAP_ID, IncreaseMaxCapacityBy: 5 })
    items.set(TONIC_POUCH_ID, { ...catalog.records.item.get(TONIC_POUCH_ID)!, IncreaseMaxCapacityForItemID: POTION_POUCH_ID, IncreaseMaxCapacityBy: 7 })
    const sources = [{ ...source, records: { ...source.records, item: items } }]
    let save = createModdedSaveEditorFixture()
    save = editSave(save, catalog, { type: 'stock', kind: 'item', id: ETHER_POUCH_ID, count: 3 }, NOW, sources)
    save = editSave(save, catalog, { type: 'stock', kind: 'item', id: TONIC_POUCH_ID, count: 4 }, NOW, sources)
    const summary = inspectSave(save, catalog, sources)
    expect(summary.inventory.find(row => row.kind === 'item' && row.id === SPAWNING_MEADOWS_MAP_ID)).toMatchObject({ capacity: 1 })
    expect(summary.inventory.find(row => row.kind === 'item' && row.id === POTION_POUCH_ID)).toMatchObject({ capacity: 99 })
    const stocked = editSave(editSave(save, catalog, { type: 'stock', kind: 'item', id: SPAWNING_MEADOWS_MAP_ID, count: 1 }, NOW, sources), catalog, { type: 'stock', kind: 'item', id: POTION_POUCH_ID, count: 99 }, NOW, sources)
    const before = structuredClone(stocked)
    expect(() => editSave(stocked, catalog, { type: 'stock', kind: 'item', id: SPAWNING_MEADOWS_MAP_ID, count: 2 }, NOW, sources)).toThrow('0 to 1')
    expect(() => editSave(stocked, catalog, { type: 'stock', kind: 'item', id: POTION_POUCH_ID, count: 100 }, NOW, sources)).toThrow('0 to 99')
    expect(stocked).toEqual(before)
  })

  it('uses redirected mod item and pouch identities when computing capacity', () => {
    const TARGET_SOURCE_ID = 500
    const POUCH_SOURCE_ID = 501
    const TARGET_SAVED_ID = 700
    const POUCH_SAVED_ID = 701
    const source = createSaveEditorModSourceFixture()
    const items = new Map(source.records.item)
    items.set(TARGET_SOURCE_ID, { ...catalog.records.item.get(POTION_ID)!, ID: TARGET_SOURCE_ID, Name: 'Synthetic redirected draught', MaxCapacity: 3 })
    items.set(POUCH_SOURCE_ID, { ...catalog.records.item.get(POTION_POUCH_ID)!, ID: POUCH_SOURCE_ID, Name: 'Synthetic redirected pouch', IncreaseMaxCapacityForItemID: TARGET_SOURCE_ID, IncreaseMaxCapacityBy: 4 })
    const sources = [{ ...source, records: { ...source.records, item: items } }]
    const save = createModdedSaveEditorFixture()
    const pairs = [{ originalId: TARGET_SOURCE_ID, newId: TARGET_SAVED_ID }, { originalId: POUCH_SOURCE_ID, newId: POUCH_SAVED_ID }]
    save.header.modIdMaps[0]!.groups.items = pairs
    const redirect = doc(arr(doc(save.party.value.Mods).value.Redirects)[0])
    const itemRedirect = doc(redirect.value.Items)
    itemRedirect.value.Count = { type: 'int32', value: pairs.length }
    itemRedirect.value.IDs = { type: 'array', value: pairs.map(pair => ({ type: 'document', value: { O: { type: 'int32', value: pair.originalId }, N: { type: 'int32', value: pair.newId } } })) }
    const resolution = resolveSaveEditorMods(save, catalog, sources)
    expect(resolution.issues).toEqual([])
    expect(resolution.catalog.records.item.get(POUCH_SAVED_ID)?.IncreaseMaxCapacityForItemID).toBe(TARGET_SAVED_ID)
    expect(items.get(POUCH_SOURCE_ID)?.IncreaseMaxCapacityForItemID).toBe(TARGET_SOURCE_ID)
    const pouches = editSave(save, catalog, { type: 'stock', kind: 'item', id: POUCH_SAVED_ID, count: 2 }, NOW, sources)
    expect(inspectSave(pouches, catalog, sources).inventory.find(row => row.kind === 'item' && row.id === TARGET_SAVED_ID)).toMatchObject({ capacity: 11 })
    const stocked = editSave(pouches, catalog, { type: 'stock', kind: 'item', id: TARGET_SAVED_ID, count: 11 }, NOW, sources)
    const before = structuredClone(stocked)
    expect(() => editSave(stocked, catalog, { type: 'stock', kind: 'item', id: TARGET_SAVED_ID, count: 12 }, NOW, sources)).toThrow('0 to 11')
    expect(stocked).toEqual(before)
    const roundTrip = decodeCrystalSave(encodeCrystalSave(stocked))
    expect(inspectSave(roundTrip, catalog, sources)).toMatchObject({ editable: true, issues: [] })
    expect(roundTrip.header.modIdMaps).toEqual(save.header.modIdMaps)
  })

  it('ignores Keep Equipment uniqueness caps for randomized gear while counting equipped copies', () => {
    const save = createSaveEditorFixture()
    flag(save, 'KeepEquipment')
    doc(save.party.value.GameplayFlags).value.LimitlessEquipment = { type: 'boolean', value: false }
    arr(save.members[0]!.value.Equipment)[0] = { type: 'int32', value: CONTRACT_SWORD_ID }
    expect(catalog.records.equipment.get(CONTRACT_SWORD_ID)).toMatchObject({ Name: 'Contract', MaxCapacity: 1 })
    expect(inspectSave(save, catalog).inventory.find(row => row.kind === 'equipment' && row.id === CONTRACT_SWORD_ID)).toMatchObject({ capacity: 0, equipped: 1 })
    setSaveEditorFixtureRandomizer(save, { flags: { Equipment: true }, mappings: { Equipment: swap(591, 0, CONTRACT_SWORD_ID) } })
    expect(inspectSave(save, catalog)).toMatchObject({ editable: true, issues: [], randomized: true })
    expect(inspectSave(save, catalog).inventory.find(row => row.kind === 'equipment' && row.id === CONTRACT_SWORD_ID)).toMatchObject({ capacity: 98, equipped: 1 })
    const stocked = editSave(save, catalog, { type: 'stock', kind: 'equipment', id: CONTRACT_SWORD_ID, count: 98 }, NOW)
    const before = structuredClone(stocked)
    const bytes = encodeCrystalSave(stocked)
    expect(() => editSave(stocked, catalog, { type: 'stock', kind: 'equipment', id: CONTRACT_SWORD_ID, count: 99 }, NOW)).toThrow('0 to 98')
    expect(stocked).toEqual(before)
    expect(encodeCrystalSave(stocked)).toEqual(bytes)
    const roundTrip = decodeCrystalSave(bytes)
    expect(inspectSave(roundTrip, catalog)).toMatchObject({ editable: true, randomized: true })
    expect(doc(roundTrip.party.value.RandomizerMapping).value).toEqual(doc(save.party.value.RandomizerMapping).value)
    expect(encodeCrystalSave(roundTrip)).toEqual(bytes)
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

  it('applies a complete compatible loadout and reconciles inventory atomically', () => {
    const original = createSaveEditorFixture()
    arr(original.members[0]?.value.LearnedPassives)[0] = { type: 'int32', value: 2 }
    const stocked = editSave(original, catalog, { type: 'stock', kind: 'equipment', id: 50, count: 1 }, NOW)
    const edited = editSave(stocked, catalog, { type: 'loadout', index: 0, jobId: 0, subJobId: 4, equipmentIds: [0, null, null, null, 50, null], passiveIds: [0] }, NOW)
    expect(inspectSave(edited, catalog).members[0]).toMatchObject({ equipmentIds: [0, null, null, null, 50, null], passiveIds: [0] })
    expect(inspectSave(edited, catalog).inventory.find(row => row.kind === 'equipment' && row.id === 50)).toMatchObject({ count: 0, equipped: 1 })
    expect(num(doc(edited.members[0]?.value.Passives).value.CurrentPP)).toBe(7)
    expect(previewSaveChanges(stocked, edited, catalog)).toEqual(expect.arrayContaining(['Alex: equipped loadout updated and inventory reconciled']))
    expect(original.members[0]?.value.Equipment).toEqual(createSaveEditorFixture().members[0]?.value.Equipment)
  })

  it('rejects unavailable, unlearned, over-budget, and slot-incompatible loadouts without mutation', () => {
    const original = createSaveEditorFixture()
    const before = structuredClone(original)
    expect(() => editSave(original, catalog, { type: 'loadout', index: 0, jobId: 0, subJobId: 4, equipmentIds: [50, null, null, null, null, null], passiveIds: [] }, NOW)).toThrow('does not fit main hand')
    expect(() => editSave(original, catalog, { type: 'loadout', index: 0, jobId: 0, subJobId: 4, equipmentIds: [0, null, null, null, 50, null], passiveIds: [] }, NOW)).toThrow('Inventory needs')
    expect(() => editSave(original, catalog, { type: 'loadout', index: 0, jobId: 0, subJobId: 4, equipmentIds: [0, null, null, null, null, null], passiveIds: [0] }, NOW)).toThrow('has not been learned')
    expect(original).toEqual(before)
    const twoHanded = editSave(editSave(original, catalog, { type: 'stock', kind: 'equipment', id: 2, count: 1 }, NOW), catalog, { type: 'stock', kind: 'equipment', id: 44, count: 1 }, NOW)
    expect(() => editSave(twoHanded, catalog, { type: 'loadout', index: 0, jobId: 0, subJobId: 4, equipmentIds: [2, 44, null, null, null, null], passiveIds: [] }, NOW)).toThrow('two-handed weapon')
    for (const id of [0, 1, 3, 4]) arr(original.members[0]?.value.LearnedPassives)[id] = { type: 'int32', value: 2 }
    const learned = structuredClone(original)
    expect(() => editSave(original, catalog, { type: 'loadout', index: 0, jobId: 0, subJobId: 4, equipmentIds: [0, null, null, null, null, null], passiveIds: [0, 1, 3, 4] }, NOW)).toThrow('PP limit')
    expect(original).toEqual(learned)
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
    expect(previewSaveChanges(save, edited, catalog)).toEqual(expect.arrayContaining(['Alex: equipped passives and available points updated', 'Alex: unavailable automatic ability cleared']))
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
    expect(() => editSave(save, catalog, { type: 'member', index: 0, jobId: 4 }, NOW)).toThrowError(new Error('This challenge prevents that class change'))
    expect(() => editSave(save, catalog, { type: 'member', index: 0, subJobId: null }, NOW)).toThrowError(new Error('This challenge prevents that class change'))
    expect(() => editSave(save, catalog, { type: 'overpowered' }, NOW)).toThrowError(new Error('This save disables assist options. Setting level 99 above the current cap of 60 requires the level-cap assist.'))
    expect(inspectSave(save, catalog).currency).toBe(123)
    flag(save, 'MaxLevelDown')
    doc(save.party.value.GameplayFlags).value.MaxLevelDownVal = { type: 'int32', value: 10 }
    expect(() => editSave(save, catalog, { type: 'member', index: 0, level: 11 }, NOW)).toThrowError(new Error("This save's maximum-level challenge limits characters to level 10. Level 11 is not allowed."))
  })

  it.each([false, true])('enforces a level-59 challenge before assist restrictions when NoAssistOptions is %s', noAssistOptions => {
    const fixture = createSaveEditorFixture()
    flag(fixture, 'MaxLevelDown')
    const gameplay = doc(fixture.party.value.GameplayFlags)
    gameplay.value.MaxLevelDownVal = { type: 'int32', value: 59 }
    gameplay.value.NoAssistOptions = { type: 'boolean', value: noAssistOptions }
    const bytes = encodeCrystalSave(fixture)
    const original = decodeCrystalSave(bytes)
    const before = structuredClone(original)
    expect(inspectSave(original, catalog)).toMatchObject({ editable: true, levelCap: 59, levelCapCanBeRaised: false, assistEnabled: false })

    const permitted = editSave(original, catalog, { type: 'member', index: 0, level: 59 }, NOW)
    expect(inspectSave(permitted, catalog)).toMatchObject({ levelCap: 59, levelCapCanBeRaised: false, assistEnabled: false, members: [{ level: 59 }, {}, {}, {}] })
    expect(permitted.header.assistFlags & LEVEL_CAP_ASSIST_FLAG).toBe(0)
    expect(doc(permitted.party.value.GameplayFlags).value.MaxLevelDown).toEqual({ type: 'boolean', value: true })
    expect(doc(permitted.party.value.GameplayFlags).value.NoAssistOptions).toEqual({ type: 'boolean', value: noAssistOptions })

    expect(() => editSave(original, catalog, { type: 'member', index: 0, level: 60 }, NOW)).toThrowError(new Error("This save's maximum-level challenge limits characters to level 59. Level 60 is not allowed."))
    expect(() => editSave(original, catalog, { type: 'member', index: 0, name: 'Avery', level: 60 }, NOW)).toThrowError(new Error("This save's maximum-level challenge limits characters to level 59. Level 60 is not allowed."))
    expect(original).toEqual(before)
    expect(encodeCrystalSave(original)).toEqual(bytes)
    expect(() => editSave(original, catalog, { type: 'overpowered' }, NOW)).toThrowError(new Error("This save's maximum-level challenge limits characters to level 59. Level 99 is not allowed."))
    expect(original).toEqual(before)
    expect(encodeCrystalSave(original)).toEqual(bytes)
    expect(original.originalBytes).toEqual(bytes)
  })

  it('allows level 60 with assists disabled and rejects higher levels without mutating the source', () => {
    const fixture = createSaveEditorFixture()
    flag(fixture, 'NoAssistOptions')
    const bytes = encodeCrystalSave(fixture)
    const original = decodeCrystalSave(bytes)
    const before = structuredClone(original)
    expect(inspectSave(original, catalog)).toMatchObject({ editable: true, levelCap: 60, levelCapCanBeRaised: false, assistEnabled: false })
    const permitted = editSave(original, catalog, { type: 'member', index: 0, level: 60 }, NOW)
    expect(inspectSave(permitted, catalog)).toMatchObject({ levelCap: 60, levelCapCanBeRaised: false, assistEnabled: false, members: [{ level: 60 }, {}, {}, {}] })
    expect(permitted.header.assistFlags & LEVEL_CAP_ASSIST_FLAG).toBe(0)
    expect(() => editSave(original, catalog, { type: 'member', index: 0, name: 'Avery', level: 61 }, NOW)).toThrowError(new Error('This save disables assist options. Setting level 61 above the current cap of 60 requires the level-cap assist.'))
    expect(original).toEqual(before)
    expect(encodeCrystalSave(original)).toEqual(bytes)
    expect(() => editSave(original, catalog, { type: 'overpowered' }, NOW)).toThrowError(new Error('This save disables assist options. Setting level 99 above the current cap of 60 requires the level-cap assist.'))
    expect(original).toEqual(before)
    expect(encodeCrystalSave(original)).toEqual(bytes)
    expect(original.originalBytes).toEqual(bytes)
  })

  it('enables the level-cap assist when an unrestricted character advances from level 60 to 61', () => {
    const atCap = editSave(createSaveEditorFixture(), catalog, { type: 'member', index: 0, level: 60 }, NOW)
    const before = structuredClone(atCap)
    expect(inspectSave(atCap, catalog)).toMatchObject({ levelCap: 60, levelCapCanBeRaised: true, assistEnabled: false })
    const raised = editSave(atCap, catalog, { type: 'member', index: 0, level: 61 }, NOW)
    expect(inspectSave(raised, catalog)).toMatchObject({ editable: true, levelCap: 61, levelCapCanBeRaised: true, assistEnabled: true, members: [{ level: 61 }, {}, {}, {}] })
    expect(raised.header.members[0]?.level).toBe(61)
    expect(raised.header.assistFlags & LEVEL_CAP_ASSIST_FLAG).toBe(LEVEL_CAP_ASSIST_FLAG)
    expect(doc(raised.party.value.GameplayFlags).value.MaxLevelUp).toEqual({ type: 'boolean', value: true })
    expect(doc(raised.party.value.GameplayFlags).value.MaxLevelUpVal).toEqual({ type: 'int32', value: 61 })
    expect(atCap).toEqual(before)
  })

  it('permits an unrelated name edit when the saved level already exceeds the challenge cap', () => {
    const fixture = editSave(createSaveEditorFixture(), catalog, { type: 'member', index: 0, level: 60 }, NOW)
    flag(fixture, 'MaxLevelDown')
    flag(fixture, 'NoAssistOptions')
    doc(fixture.party.value.GameplayFlags).value.MaxLevelDownVal = { type: 'int32', value: 59 }
    const bytes = encodeCrystalSave(fixture)
    const original = decodeCrystalSave(bytes)
    const before = structuredClone(original)
    expect(inspectSave(original, catalog)).toMatchObject({ editable: true, levelCap: 59, levelCapCanBeRaised: false, members: [{ level: 60 }, {}, {}, {}] })
    for (const command of [
      { type: 'member' as const, index: 0, name: 'Avery' },
      { type: 'member' as const, index: 0, name: 'Avery', level: 60 },
    ]) {
      const named = editSave(original, catalog, command, NOW)
      expect(named.header.members[0]).toMatchObject({ name: 'Avery', level: 60 })
      expect(named.members[0]?.value.Levels).toEqual(original.members[0]?.value.Levels)
      expect(named.party).toEqual(original.party)
      expect(named.header.assistFlags).toBe(original.header.assistFlags)
    }
    expect(original).toEqual(before)
    expect(encodeCrystalSave(original)).toEqual(bytes)
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
    expect(summary.levelCapCanBeRaised).toBe(false)
    expect(edited.header.assistFlags & LEVEL_CAP_ASSIST_FLAG).toBe(LEVEL_CAP_ASSIST_FLAG)
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
      (save: CrystalSave) => { flag(save, 'NoAssistOptions'); flag(save, 'MaxLevelUp'); doc(save.party.value.GameplayFlags).value.MaxLevelUpVal = { type: 'int32', value: 99 }; save.header.assistFlags |= LEVEL_CAP_ASSIST_FLAG },
      (save: CrystalSave) => { flag(save, 'MaxLevelUp'); doc(save.party.value.GameplayFlags).value.MaxLevelUpVal = { type: 'int32', value: 59 }; save.header.assistFlags |= LEVEL_CAP_ASSIST_FLAG },
      (save: CrystalSave) => { save.header.assistFlags |= LEVEL_CAP_ASSIST_FLAG },
    ]
    for (const mutate of cases) {
      const save = createSaveEditorFixture()
      mutate(save)
      expect(inspectSave(save, catalog)).toMatchObject({ editable: false, levelCapCanBeRaised: false })
      expect(() => editSave(save, catalog, { type: 'currency', value: 456 }, NOW)).toThrow()
    }
  })
})
