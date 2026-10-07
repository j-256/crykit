import { describe, expect, it } from 'vitest'
import { STARTER_CATALOG } from '../catalog'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { createBlankLocalData } from '../domain'
import type { CatalogRef, JsonValue, PersonalDefinitionId, ValidationIssue } from '../domain/types'
import { buildDefinitionOptions } from './definitions'
import { compactKnowledge, decisionFacts, definitionChoiceSourceLabel, groupValidationIssues, hasNameEvidenceOnly, isReferenceArticle, nativeListedStat, nativeStatSourceNotice, selectionSummaryLines, similarNameOptions, summaryFactLines } from './build-evidence'
import { nativeRecord, nativeSourceRecord } from '../domain/native-game'

const localData = createBlankLocalData()
const options = buildDefinitionOptions(localData, [STARTER_CATALOG])
const option = (name: string) => options.find((entry) => entry.name === name)!
const NATIVE_CRIT_RESIST_TAG = 53
const NATIVE_FLAT_HP_TAG = 0
const NATIVE_PERCENT_HP_TAG = 20

describe('build choice evidence', () => {
  it('excludes only identified reference articles, including their personal lineage', () => {
    const article = buildDefinitionOptions(localData, [DEFAULT_CATALOG]).find(entry => entry.name === 'Katanas')!
    expect(isReferenceArticle(localData, article.ref)).toBe(true)
    expect(isReferenceArticle(localData, option('Muramasa').ref)).toBe(false)
    expect(isReferenceArticle(localData, { ...(article.ref as CatalogRef), catalogId: 'unrelated-catalog' as CatalogRef['catalogId'] })).toBe(false)
    const personal = { kind: 'personal' as const, definitionId: 'synthetic-article' as PersonalDefinitionId }
    const overridden = { ...localData, personalDefinitions: { [personal.definitionId]: { ...article.record, id: personal.definitionId, baseRef: article.ref } } } as unknown as typeof localData
    expect(isReferenceArticle(overridden, personal)).toBe(true)
  })

  it('keeps uncertain spellings separate and labels the name-only record', () => {
    const detailed = option("Viking's Hat")
    const nameOnly = option('Vikings Hat')
    expect(detailed.key).not.toBe(nameOnly.key)
    expect(hasNameEvidenceOnly(detailed.record)).toBe(false)
    expect(hasNameEvidenceOnly(nameOnly.record)).toBe(true)
    expect(hasNameEvidenceOnly({ ...nameOnly.record, fields: { ...nameOnly.record.fields, 'Native source record': { state: 'known', value: { ID: 7, Name: 'Synthetic native item' } } } })).toBe(false)
    expect(similarNameOptions(localData, options).get(nameOnly.key)?.map((entry) => entry.key)).toContain(detailed.key)
  })

  it('exposes effects and numeric facts without duplicate stat text or invented totals', () => {
    const fang = decisionFacts(option('Crit Fang').record)
    expect(fang.filter((fact) => /Crit\. Chance/.test(compactKnowledge(fact.value)))).toHaveLength(1)
    expect(fang.some((fact) => /Accuracy: \+20/.test(compactKnowledge(fact.value)))).toBe(true)
    expect(decisionFacts(option('Muramasa').record)).toContainEqual({ label: 'Attack', value: option('Muramasa').record.fields.Attack })
    const record = { ...option('Muramasa').record, fields: { Defense: { state: 'known' as const, value: 50 }, Resistance: { state: 'known' as const, value: 50 }, Attack: { state: 'conflicting' as const, claims: [{ value: 1, sources: [] }, { value: 2, sources: [] }] } } }
    expect(decisionFacts(record)).toHaveLength(3)
    expect(compactKnowledge(record.fields.Attack)).toBe('Conflicting sources')
  })

  it('condenses overlapping contribution fields into unique tooltip lines', () => {
    expect(summaryFactLines(option('Oak Wand').record)).toEqual(['Attack: +42', 'Mind: +12', 'Max. MP: +4'])
    expect(summaryFactLines(option('Short Sword').record)).not.toContain('Hands: 1')
    expect(summaryFactLines({ ...option('Short Sword').record, listedContributions: undefined, fields: { Stat: { state: 'known', value: 'Mind: +2.5\nMind: +25' } } })).toEqual(['Mind: +2.5', 'Mind: +25'])
  })

  it('includes native passive descriptions alongside PP and deduplicates repeated effect lines', () => {
    const passive = { ...option('HP Boost'), description: 'Increase maximum HP by 20%.', record: { ...option('HP Boost').record, listedContributions: undefined, fields: { PP: { state: 'known' as const, value: 3 }, Description: { state: 'known' as const, value: 'Increase maximum HP by 20%.' } } } }
    expect(selectionSummaryLines(passive)).toEqual(['Increase maximum HP by 20%.', 'PP: 3'])
    const ring = { ...option('Sanity Ring'), description: 'Immune to Confusion.\nMind: +10', record: { ...option('Sanity Ring').record, listedContributions: undefined, fields: { Effect: { state: 'known' as const, value: 'Immune to Confusion.\nMind: +10' }, 'Other effects': { state: 'known' as const, value: 'Immune to Confusion.' }, Stat: { state: 'known' as const, value: 'Mind: +10' }, 'Stat bonuses': { state: 'known' as const, value: 'Mind: +10' } } } }
    expect(selectionSummaryLines(ring)).toEqual(['Immune to Confusion.', 'Mind: +10'])
    expect(Object.keys(ring.record.fields)).toHaveLength(4)
  })

  it('uses one effect representation while preserving every original source field', () => {
    const bundled = buildDefinitionOptions(localData, [DEFAULT_CATALOG])
    const sanity = selectionSummaryLines(bundled.find(value => value.name === 'Sanity Ring')!)
    expect(sanity.filter(line => /confusion/i.test(line))).toHaveLength(1)
    expect(sanity.filter(line => /mind/i.test(line))).toHaveLength(1)
    expect(sanity.filter(line => /spirit/i.test(line))).toHaveLength(1)
    expect(selectionSummaryLines(bundled.find(value => value.name === 'Tall Stand Ring')!).filter(line => /defen[cs]e/i.test(line))).toHaveLength(1)
    const original = bundled.find(value => value.name === 'Tall Stand Ring')!
    expect(summaryFactLines(original.record).map(line => line.replace(/\.$/, ''))).toEqual(selectionSummaryLines(original).map(line => line.replace(/\.$/, '')))
    expect(sanity.map(line => line.replace(/\.$/, ''))).toEqual(['Mind: +5', 'Spirit: +5', 'Immune to: Confusion', 'Cost: 110000 Copper'])
    expect(original.record.fields.Effect).toMatchObject({ state: 'known', value: '25% extra Physical Defence at Full HP.' })
    expect(original.record.fields['Other effects']).toMatchObject({ state: 'known', value: 'Gain 25% more Defense when at Max. HP' })
    const conflicting = { ...original, record: { ...original.record, fields: { ...original.record.fields, Effect: { state: 'conflicting' as const, claims: [{ value: 'First source', sources: [] }, { value: 'Second source', sources: [] }] } } } }
    expect(selectionSummaryLines(conflicting)).toContain('Effect: Conflicting sources')
  })

  it('deduplicates unitless stat fragments only when the native vocabulary corroborates their percent display', () => {
    const shield = buildDefinitionOptions(localData, [DEFAULT_CATALOG]).find(value => value.name === 'Diamond Shield')!
    const originalFields = JSON.stringify(shield.record.fields)
    expect(summaryFactLines(shield.record)).toEqual(['Defense: +100', 'Crit Resist: +25%', 'Evasion: -50', 'Cost: 350000 Copper'])
    expect(shield.record.fields.Stat).toMatchObject({ state: 'known', value: 'Evasion: -50\nCrit Resist: +25' })
    expect(shield.record.fields['Other effects']).toMatchObject({ state: 'known', value: 'Crit Resist: +25%' })
    expect(JSON.stringify(shield.record.fields)).toBe(originalFields)
  })

  it('retains uncorroborated units, distinct amounts, conditions, and unresolved source facts', () => {
    const known = (value: JsonValue) => ({ state: 'known' as const, value })
    const record = {
      ...option('Short Sword').record,
      listedContributions: undefined,
      legacy: { native: { database: 'equipment', databaseId: 9001, mode: 'base' } },
      fields: {
        'Game version': known('1.6.9'),
        'Native source record': known({ StatMods: [{ Tag: NATIVE_CRIT_RESIST_TAG, Value1: 25, Value2: 0, Value3: 0 }] }),
        'Other effects': known('Crit Resist: +25%'),
        Stat: known('Crit Resist: +25'),
      },
    }
    expect(summaryFactLines(record)).toEqual(['Crit Resist: +25%', 'Crit Resist: +25'])
    expect(summaryFactLines({ ...record, legacy: undefined })).toContain('Crit Resist: +25')
    for (const fields of [
      { 'Native source record': { state: 'unknown' as const } },
      { 'Game version': known('other-version') },
      { 'Native source record': known({ StatMods: [{ Tag: NATIVE_CRIT_RESIST_TAG, Value1: 50, Value2: 0, Value3: 0 }] }) },
      { 'Native source record': known({ StatMods: [{ Tag: NATIVE_CRIT_RESIST_TAG, Value1: 25, Value2: 1, Value3: 0 }] }) },
      { 'Other effects': known('Crit Resist: +50%') },
      { 'Other effects': known('') },
    ]) expect(summaryFactLines({ ...record, fields: { ...record.fields, ...fields } })).toContain('Crit Resist: +25')
    for (const line of ['Crit Resist: +20', 'Crit Resist: +2.5', 'Crit Resist: +25 points', 'Crit Resist: +25 when at full HP']) {
      expect(summaryFactLines({ ...record, fields: { ...record.fields, Stat: known(line) } })).toContain(line)
    }
    const flatAndPercent = { ...record, fields: { ...record.fields, 'Native source record': known({ StatMods: [{ Tag: NATIVE_FLAT_HP_TAG, Value1: 25, Value2: 0, Value3: 0 }, { Tag: NATIVE_PERCENT_HP_TAG, Value1: 25, Value2: 0, Value3: 0 }] }), 'Other effects': known('Max. HP: +25%'), Stat: known('Max. HP: +25') } }
    expect(summaryFactLines(flatAndPercent)).toEqual(['Max. HP: +25%', 'Max. HP: +25'])
    expect(summaryFactLines({ ...record, fields: { ...record.fields, Stat: { state: 'unknown' } } })).toContain('Stat: Unknown')
    expect(summaryFactLines({ ...record, fields: { ...record.fields, Stat: { state: 'conflicting', claims: [{ value: 'Crit Resist: +25', sources: [] }, { value: 'Crit Resist: +50', sources: [] }] } } })).toContain('Stat: Conflicting sources')
  })

  it('puts monetary cost after combat and permission facts', () => {
    const record = { ...option('Short Sword').record, listedContributions: undefined, fields: { Cost: { state: 'known' as const, value: '100 Copper' }, Weapons: { state: 'known' as const, value: 'Swords' }, Attack: { state: 'known' as const, value: 30 }, Effects: { state: 'unknown' as const } } }
    expect(decisionFacts(record).map(fact => fact.label)).toEqual(['Weapons', 'Attack', 'Effects', 'Cost'])
    expect(summaryFactLines(record).at(-1)).toBe('Cost: 100 Copper')
    const nativeCost = { ...record, fields: { Attack: record.fields.Attack, 'Cost (copper)': { state: 'known' as const, value: 710 } } }
    expect(decisionFacts(nativeCost)).toEqual([{ label: 'Attack', value: record.fields.Attack }, { label: 'Cost', value: { state: 'known', value: '710 Copper' } }])
    expect(summaryFactLines(nativeCost).at(-1)).toBe('Cost: 710 Copper')
  })

  it('groups shared causes without hiding invalid checks among unknown ones', () => {
    const issue: ValidationIssue = { code: 'PERMISSION_REQUIREMENTS_UNKNOWN', status: 'undetermined', dimension: 'equipment', message: 'Requirements unknown' }
    const issues = [issue, { ...issue, slotId: 'off-hand' as ValidationIssue['slotId'] }, { ...issue, status: 'invalid' as const }]
    const groups = groupValidationIssues(issues)
    expect(groups.map((group) => group.length)).toEqual([2, 1])
    expect(groups.flat()).toEqual(issues)
  })

  it('shows native item stats without conflicting supplemental amounts or duplicated labels', () => {
    const bundled = buildDefinitionOptions(localData, [DEFAULT_CATALOG])
    const shoes = bundled.find(value => value.name === 'Acrobat Shoes')!
    const beads = bundled.find(value => value.name === 'Beads of Defense')!
    const original = JSON.stringify(shoes.record)
    const lines = selectionSummaryLines(shoes)
    expect(lines.filter(line => /Dexterity/.test(line))).toEqual(['Dexterity: +14'])
    expect(lines.filter(line => /Agility/.test(line))).toEqual(['Agility: +16'])
    expect(nativeStatSourceNotice(shoes.record)).toContain('Source stat values differ; PC 1.6.9.0 values shown')
    expect(selectionSummaryLines(beads).filter(line => /Defense|Resistance/.test(line))).toEqual(['Defense: +20', 'Resistance: +20'])
    expect(JSON.stringify(shoes.record)).toBe(original)
  })

  it('distinguishes similar native robes by exact source identity, level, and stats', () => {
    const bundled = buildDefinitionOptions(localData, [DEFAULT_CATALOG])
    const early = bundled.find(value => value.name === "Cleric's Robe")!
    const late = bundled.find(value => value.name === 'Cleric Robe')!
    expect(definitionChoiceSourceLabel(early)).toContain('PC 1.6.9.0 · base database')
    expect(definitionChoiceSourceLabel(early)).toContain('equipment 123 · level 36')
    expect(definitionChoiceSourceLabel(late)).toContain('equipment 547 · level 60')
    expect(selectionSummaryLines(early)).toEqual(expect.arrayContaining(['Defense: +28', 'Resistance: +115', 'Spirit: +36']))
    expect(selectionSummaryLines(late)).toEqual(expect.arrayContaining(['Defense: +60', 'Resistance: +190', 'Spirit: +60']))
    expect(early.key).not.toBe(late.key)
  })

  it('does not promote edited native-looking fields as verified Windows stats', () => {
    const shoes = DEFAULT_CATALOG.entities['base:equipment:320']!
    const record = nativeSourceRecord(shoes)!
    const edited = { ...shoes, fields: { ...shoes.fields, 'Native source record': { state: 'known' as const, value: { ...record, StatMods: (record.StatMods as readonly JsonValue[]).map(modifier => nativeRecord(modifier) ? { ...modifier, Value1: 999 } : modifier) } } } }
    expect(nativeListedStat(shoes, 'Dexterity')).toBe(14)
    expect(nativeListedStat(edited, 'Dexterity')).toBeUndefined()
    expect(nativeStatSourceNotice(edited)).toBeUndefined()
    const shield = buildDefinitionOptions(localData, [DEFAULT_CATALOG]).find(option => option.record.id === 'base:equipment:237')!
    expect(selectionSummaryLines(shield).filter(line => line.includes('Crit Resist'))).toEqual(['Crit Resist: +25%'])
  })
})
