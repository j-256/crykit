import { describe, expect, it } from 'vitest'
import { validateNativeProfileGraph } from '../interchange/native'
import { assertModConfiguration, modState, recordedModNames, updateModSelections } from './mods'
import { updateRulesetRevision } from './profile'
import { createTestProfile, known, TEST_RULESET_REVISION_ID } from './test-helpers'
import type { Knowledge } from './types'

describe('explicit mod configuration', () => {
  it('normalizes spelling without inferring disabled mods from missing enabled entries', () => {
    const configuration = { mods: known(['DOGE  SHIELD']), disabledMods: known(['Bloodmage']) }
    expect(modState(configuration, 'doge shield')).toBe('enabled')
    expect(modState(configuration, ' Bloodmage ')).toBe('disabled')
    expect(modState(configuration, 'Tempest')).toBe('unknown')
    expect(modState({ mods: known(['Mod Pack 2']) }, 'Bloodmage')).toBe('unknown')
    expect(modState(undefined, 'Bloodmage')).toBe('unknown')
  })

  it('moves a selected mod between states without dropping unlisted imported names or inferring other choices', () => {
    const original = { mods: known(['DOGE  SHIELD', 'Synthetic imported mod']), disabledMods: known(['Bloodmage', 'Synthetic disabled mod']) }
    const disabled = updateModSelections(original, [{ name: 'Doge Shield', state: 'disabled' }])
    expect(disabled).toEqual({ mods: known(['Synthetic imported mod']), disabledMods: known(['Bloodmage', 'Synthetic disabled mod', 'Doge Shield']) })
    expect(modState(disabled, 'Doge Shield')).toBe('disabled')
    expect(modState(disabled, 'Tempest')).toBe('unknown')
    const cleared = updateModSelections(disabled, [{ name: 'Bloodmage', state: 'unknown' }])
    expect(modState(cleared, 'Bloodmage')).toBe('unknown')
    expect(cleared.disabledMods).toEqual(known(['Synthetic disabled mod', 'Doge Shield']))
    const enabled = updateModSelections(cleared, [{ name: 'Doge Shield', state: 'enabled' }])
    expect(enabled).toEqual({ mods: known(['Synthetic imported mod', 'Doge Shield']), disabledMods: known(['Synthetic disabled mod']) })
    expect(original.mods).toEqual(known(['DOGE  SHIELD', 'Synthetic imported mod']))
    expect(original.disabledMods).toEqual(known(['Bloodmage', 'Synthetic disabled mod']))
  })

  it('preserves unknown and not-applicable lists when their membership does not change', () => {
    const original = { mods: { state: 'unknown' as const, reason: 'Unrecorded setup' }, disabledMods: { state: 'notApplicable' as const, reason: 'Imported context' } }
    expect(updateModSelections(original, [])).toEqual(original)
    const edited = updateModSelections(original, [{ name: 'Bloodmage', state: 'enabled' }])
    expect(edited.mods).toEqual(known(['Bloodmage']))
    expect(edited.disabledMods).toBe(original.disabledMods)
    expect(updateModSelections({ mods: known([]) }, [{ name: 'Bloodmage', state: 'unknown' }]).disabledMods).toBeUndefined()
  })

  it('resolves only the selected name in conflicting alternatives and retains the original evidence', () => {
    const conflicting: Knowledge<readonly string[]> = { state: 'conflicting', claims: [
      { value: ['Doge Shield', 'Synthetic imported mod'], sources: [{ sourceId: 'synthetic-a' }] },
      { value: ['Tempest'], sources: [{ sourceId: 'synthetic-b' }] },
    ] }
    const original = { mods: conflicting, disabledMods: known(['Doge Shield']) }
    const edited = updateModSelections(original, [{ name: 'Doge Shield', state: 'disabled' }, { name: 'Bloodmage', state: 'enabled' }])
    expect(modState(edited, 'Doge Shield')).toBe('disabled')
    expect(modState(edited, 'Bloodmage')).toBe('enabled')
    expect(modState(edited, 'Tempest')).toBe('conflicting')
    expect(modState(edited, 'Synthetic imported mod')).toBe('conflicting')
    expect(edited.mods).toEqual({ state: 'conflicting', claims: [
      { value: ['Synthetic imported mod', 'Bloodmage'], sources: [] },
      { value: ['Tempest', 'Bloodmage'], sources: [] },
    ] })
    expect(recordedModNames(edited)).toEqual(['Synthetic imported mod', 'Bloodmage', 'Tempest', 'Doge Shield'])
    expect(conflicting.claims[0].sources).toEqual([{ sourceId: 'synthetic-a' }])
    const partlyChanged = updateModSelections(original, [{ name: 'Doge Shield', state: 'unknown' }])
    expect(partlyChanged.mods.state === 'conflicting' && partlyChanged.mods.claims[1]).toBe(conflicting.claims[1])
    const resolved = updateModSelections({ mods: { state: 'conflicting', claims: [{ value: ['Doge Shield'], sources: [] }, { value: [], sources: [] }] } }, [{ name: 'Doge Shield', state: 'enabled' }])
    expect(resolved.mods).toEqual(known(['Doge Shield']))
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
