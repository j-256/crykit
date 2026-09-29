import { describe, expect, it } from 'vitest'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { assertModConfiguration, modState, recordedModNames, updateModSelections } from './mods'
import { updateGameSetupRevision } from './local-data'
import { createTestLocalData, known, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
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

  it('pins changes to a new gameSetup revision and retains legacy and conflicting states', () => {
    const original = createTestLocalData()
    const configured = updateGameSetupRevision(original, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, mods: known(['Synthetic mod']), disabledMods: known(['Synthetic disabled mod']) })
    const revised = updateGameSetupRevision(configured, { sourceRevisionId: configured.planningGameSetupRevisionId!, label: 'Renamed gameSetup' })
    expect(revised.gameSetups[revised.planningGameSetupRevisionId!].disabledMods).toEqual(known(['Synthetic disabled mod']))
    expect(original.gameSetups[TEST_GAME_SETUP_REVISION_ID].disabledMods).toBeUndefined()
    expect(revised.gameSetups[TEST_GAME_SETUP_REVISION_ID]).toEqual(original.gameSetups[TEST_GAME_SETUP_REVISION_ID])
    expect(() => validateNativeLocalDataGraph(original, [])).not.toThrow()
    expect(() => validateNativeLocalDataGraph(JSON.parse(JSON.stringify(revised)), [])).not.toThrow()
    const conflicting: Knowledge<readonly string[]> = { state: 'conflicting', claims: [{ value: ['Synthetic mod'], sources: [] }, { value: [], sources: [] }] }
    const imported = updateGameSetupRevision(original, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, mods: conflicting, disabledMods: { state: 'notApplicable', reason: 'Unresolved source context' } })
    const renamed = updateGameSetupRevision(imported, { sourceRevisionId: imported.planningGameSetupRevisionId!, label: 'Keep source claims' })
    expect(renamed.gameSetups[renamed.planningGameSetupRevisionId!].mods).toBe(conflicting)
    expect(renamed.gameSetups[renamed.planningGameSetupRevisionId!].disabledMods).toEqual({ state: 'notApplicable', reason: 'Unresolved source context' })
  })

  it('rejects contradictory gameSetup writes and backups without changing the localData', () => {
    const localData = createTestLocalData()
    const original = JSON.stringify(localData)
    const change = { mods: known(['Synthetic mod']), disabledMods: known(['Synthetic MOD']) }
    expect(() => updateGameSetupRevision(localData, { sourceRevisionId: TEST_GAME_SETUP_REVISION_ID, ...change })).toThrow('both enabled and disabled')
    const invalid = { ...localData, gameSetups: { ...localData.gameSetups, [TEST_GAME_SETUP_REVISION_ID]: { ...localData.gameSetups[TEST_GAME_SETUP_REVISION_ID], ...change } } }
    expect(() => validateNativeLocalDataGraph(invalid, [])).toThrow('both enabled and disabled')
    expect(JSON.stringify(localData)).toBe(original)
  })
})
