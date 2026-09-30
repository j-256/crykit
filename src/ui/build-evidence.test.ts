import { describe, expect, it } from 'vitest'
import { STARTER_CATALOG } from '../catalog'
import { createBlankLocalData } from '../domain'
import type { CatalogRef, PersonalDefinitionId, ValidationIssue } from '../domain/types'
import { buildDefinitionOptions } from './definitions'
import { compactKnowledge, decisionFacts, groupValidationIssues, hasNameEvidenceOnly, isReferenceArticle, similarNameOptions, summaryFactLines } from './build-evidence'

const localData = createBlankLocalData()
const options = buildDefinitionOptions(localData, [STARTER_CATALOG])
const option = (name: string) => options.find((entry) => entry.name === name)!

describe('build choice evidence', () => {
  it('excludes only identified reference articles, including their personal lineage', () => {
    const article = option('Katanas')
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
  })

  it('puts monetary cost after combat and permission facts', () => {
    const record = { ...option('Short Sword').record, listedContributions: undefined, fields: { Cost: { state: 'known' as const, value: '100 Copper' }, Weapons: { state: 'known' as const, value: 'Swords' }, Attack: { state: 'known' as const, value: 30 }, Effects: { state: 'unknown' as const } } }
    expect(decisionFacts(record).map(fact => fact.label)).toEqual(['Weapons', 'Attack', 'Effects', 'Cost'])
    expect(summaryFactLines(record).at(-1)).toBe('Cost: 100 Copper')
  })

  it('groups shared causes without hiding invalid checks among unknown ones', () => {
    const issue: ValidationIssue = { code: 'PERMISSION_REQUIREMENTS_UNKNOWN', status: 'undetermined', dimension: 'equipment', message: 'Requirements unknown' }
    const issues = [issue, { ...issue, slotId: 'off-hand' as ValidationIssue['slotId'] }, { ...issue, status: 'invalid' as const }]
    const groups = groupValidationIssues(issues)
    expect(groups.map((group) => group.length)).toEqual([2, 1])
    expect(groups.flat()).toEqual(issues)
  })
})
