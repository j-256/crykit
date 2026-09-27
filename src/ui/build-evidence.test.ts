import { describe, expect, it } from 'vitest'
import { STARTER_CATALOG } from '../catalog'
import { createBlankProfile } from '../domain'
import type { CatalogRef, PersonalDefinitionId, ValidationIssue } from '../domain/types'
import { buildDefinitionOptions } from './definitions'
import { compactKnowledge, decisionFacts, groupValidationIssues, hasNameEvidenceOnly, isReferenceArticle, passivePpSummary, similarNameOptions } from './build-evidence'

const profile = createBlankProfile({ label: 'Synthetic build evidence' })
const options = buildDefinitionOptions(profile, [STARTER_CATALOG])
const option = (name: string) => options.find((entry) => entry.name === name)!

describe('build choice evidence', () => {
  it('excludes only identified reference articles, including their personal lineage', () => {
    const article = option('Katanas')
    expect(isReferenceArticle(profile, article.ref)).toBe(true)
    expect(isReferenceArticle(profile, option('Muramasa').ref)).toBe(false)
    expect(isReferenceArticle(profile, { ...(article.ref as CatalogRef), catalogId: 'unrelated-catalog' as CatalogRef['catalogId'] })).toBe(false)
    const personal = { kind: 'personal' as const, definitionId: 'synthetic-article' as PersonalDefinitionId }
    const overridden = { ...profile, personalDefinitions: { [personal.definitionId]: { ...article.record, id: personal.definitionId, baseRef: article.ref } } } as unknown as typeof profile
    expect(isReferenceArticle(overridden, personal)).toBe(true)
  })

  it('keeps uncertain spellings separate and labels the name-only record', () => {
    const detailed = option("Viking's Hat")
    const nameOnly = option('Vikings Hat')
    expect(detailed.key).not.toBe(nameOnly.key)
    expect(hasNameEvidenceOnly(detailed.record)).toBe(false)
    expect(hasNameEvidenceOnly(nameOnly.record)).toBe(true)
    expect(similarNameOptions(profile, options).get(nameOnly.key)?.map((entry) => entry.key)).toContain(detailed.key)
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

  it('separates known PP from unresolved and conflicting costs, including innates', () => {
    const passive = option('Attack Focus')
    expect(passivePpSummary([passive, option('Backstabber'), option('Duel Ready')])).toEqual({ knownSubtotal: 9, unresolved: 0 })
    expect(passivePpSummary([passive, option('Two-handed'), undefined, { ...passive, ppCost: { state: 'conflicting', claims: [{ value: 1, sources: [] }, { value: 3, sources: [] }] } }])).toEqual({ knownSubtotal: 2, unresolved: 3 })
    expect(passivePpSummary([{ ...passive, ppCost: { state: 'known', value: 0 } }])).toEqual({ knownSubtotal: 0, unresolved: 0 })
  })

  it('groups shared causes without hiding invalid checks among unknown ones', () => {
    const issue: ValidationIssue = { code: 'PERMISSION_REQUIREMENTS_UNKNOWN', status: 'undetermined', dimension: 'equipment', message: 'Requirements unknown' }
    const issues = [issue, { ...issue, slotId: 'off-hand' as ValidationIssue['slotId'] }, { ...issue, status: 'invalid' as const }]
    const groups = groupValidationIssues(issues)
    expect(groups.map((group) => group.length)).toEqual([2, 1])
    expect(groups.flat()).toEqual(issues)
  })
})
