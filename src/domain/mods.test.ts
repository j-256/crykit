import { describe, expect, it } from 'vitest'
import { validateNativeProfileGraph } from '../interchange/native'
import { assertModConfiguration, modState, parseModNames } from './mods'
import { updateRulesetRevision } from './profile'
import { createTestProfile, known, TEST_RULESET_REVISION_ID } from './test-helpers'
import type { Knowledge } from './types'

describe('explicit mod configuration', () => {
  it('normalizes spelling without inferring disabled mods from missing enabled entries', () => {
    expect(parseModNames(' Doge Shield \n\ndoge  shield\nBloodmage\n')).toEqual(['Doge Shield', 'Bloodmage'])
    const configuration = { mods: known(['DOGE  SHIELD']), disabledMods: known(['Bloodmage']) }
    expect(modState(configuration, 'doge shield')).toBe('enabled')
    expect(modState(configuration, ' Bloodmage ')).toBe('disabled')
    expect(modState(configuration, 'Tempest')).toBe('unknown')
    expect(modState({ mods: known(['Mod Pack 2']) }, 'Bloodmage')).toBe('unknown')
    expect(modState(undefined, 'Bloodmage')).toBe('unknown')
  })

  it('keeps imported conflicting claims explicit and rejects contradictory definite choices', () => {
    const conflicting: Knowledge<readonly string[]> = { state: 'conflicting', claims: [{ value: ['Doge Shield'], sources: [] }, { value: [], sources: [] }] }
    expect(modState({ mods: conflicting, disabledMods: known(['Doge Shield']) }, 'Doge Shield')).toBe('conflicting')
    expect(modState({ mods: known(['Doge Shield']), disabledMods: known(['doge shield']) }, 'Doge Shield')).toBe('conflicting')
    expect(() => assertModConfiguration({ mods: conflicting, disabledMods: known(['Doge Shield']) })).not.toThrow()
    expect(() => assertModConfiguration({ mods: known(['Doge Shield']), disabledMods: known(['DOGE SHIELD']) })).toThrow('both enabled and disabled')
    expect(() => assertModConfiguration({ mods: known([' ']) })).toThrow('must not be empty')
  })

  it('pins changes to a new ruleset revision and retains legacy and conflicting states', () => {
    const original = createTestProfile()
    const configured = updateRulesetRevision(original, { sourceRevisionId: TEST_RULESET_REVISION_ID, mods: known(['Synthetic mod']), disabledMods: known(['Synthetic disabled mod']) })
    const revised = updateRulesetRevision(configured, { sourceRevisionId: configured.activeRulesetRevisionId!, label: 'Renamed ruleset' })
    expect(revised.rulesets[revised.activeRulesetRevisionId!].disabledMods).toEqual(known(['Synthetic disabled mod']))
    expect(original.rulesets[TEST_RULESET_REVISION_ID].disabledMods).toBeUndefined()
    expect(revised.rulesets[TEST_RULESET_REVISION_ID]).toEqual(original.rulesets[TEST_RULESET_REVISION_ID])
    expect(() => validateNativeProfileGraph(original, [])).not.toThrow()
    expect(() => validateNativeProfileGraph(JSON.parse(JSON.stringify(revised)), [])).not.toThrow()
    const conflicting: Knowledge<readonly string[]> = { state: 'conflicting', claims: [{ value: ['Synthetic mod'], sources: [] }, { value: [], sources: [] }] }
    const imported = updateRulesetRevision(original, { sourceRevisionId: TEST_RULESET_REVISION_ID, mods: conflicting, disabledMods: { state: 'notApplicable', reason: 'Unresolved source context' } })
    const renamed = updateRulesetRevision(imported, { sourceRevisionId: imported.activeRulesetRevisionId!, label: 'Keep source claims' })
    expect(renamed.rulesets[renamed.activeRulesetRevisionId!].mods).toBe(conflicting)
    expect(renamed.rulesets[renamed.activeRulesetRevisionId!].disabledMods).toEqual({ state: 'notApplicable', reason: 'Unresolved source context' })
  })

  it('rejects contradictory ruleset writes and backups without changing the profile', () => {
    const profile = createTestProfile()
    const original = JSON.stringify(profile)
    const change = { mods: known(['Synthetic mod']), disabledMods: known(['Synthetic MOD']) }
    expect(() => updateRulesetRevision(profile, { sourceRevisionId: TEST_RULESET_REVISION_ID, ...change })).toThrow('both enabled and disabled')
    const invalid = { ...profile, rulesets: { ...profile.rulesets, [TEST_RULESET_REVISION_ID]: { ...profile.rulesets[TEST_RULESET_REVISION_ID], ...change } } }
    expect(() => validateNativeProfileGraph(invalid, [])).toThrow('both enabled and disabled')
    expect(JSON.stringify(profile)).toBe(original)
  })
})
