import { addGameSetupRevision, createBuild, createPersonalDefinition, saveBuildRevision } from '../src/domain'
import { personalRef, TEST_NOW } from '../src/domain/test-helpers'
import type { BuildId, GameSetupRevisionId, LocalData } from '../src/domain/types'

export const MODDED_BUILD_TITLE = 'Synthetic modded Build'
export const ENABLED_MOD = 'Synthetic mod with a long name for classes and passives'
export const UNKNOWN_MOD = 'Synthetic unconfirmed command mod'
export const DISABLED_MOD = 'Synthetic disabled equipment mod'
export const CONFLICTING_MOD = 'Synthetic conflicting passive mod'
const BUILD_ID = 'synthetic-mods-badge-build' as BuildId
const SETUP_ID = 'synthetic-mods-badge-setup' as GameSetupRevisionId

export function modsBadgeFixture(data: LocalData): LocalData {
  const source = data.gameSetups[data.planningGameSetupRevisionId!]!
  let next = addGameSetupRevision(data, {
    ...source, id: SETUP_ID, label: 'Synthetic mod badge setup',
    mods: { state: 'conflicting', claims: [{ value: [ENABLED_MOD, CONFLICTING_MOD], sources: [] }, { value: [ENABLED_MOD], sources: [] }] },
    disabledMods: { state: 'known', value: [DISABLED_MOD] },
    now: TEST_NOW,
  })
  for (const definition of [
    { name: 'Synthetic class', kind: 'class', mod: ENABLED_MOD },
    { name: 'Synthetic sub-command', kind: 'class', mod: UNKNOWN_MOD },
    { name: 'Synthetic sword', kind: 'item', mod: DISABLED_MOD },
    { name: 'Synthetic focus', kind: 'passive', mod: ENABLED_MOD },
    { name: 'Synthetic conflicting passive', kind: 'passive', mod: CONFLICTING_MOD },
  ] as const) {
    next = createPersonalDefinition(next, {
      id: personalRef(definition.name).definitionId, name: definition.name, kind: definition.kind,
      fields: { 'Source mod': { state: 'known', value: definition.mod }, Command: { state: 'known', value: 'Synthetic command' } },
      ...(definition.kind === 'passive' ? { ppCost: { state: 'known' as const, value: 2 } } : {}),
      now: TEST_NOW,
    })
  }
  next = createBuild(next, { id: BUILD_ID, gameSetupId: source.gameSetupId, title: MODDED_BUILD_TITLE, now: TEST_NOW })
  return saveBuildRevision(next, {
    buildId: BUILD_ID, gameSetupRevisionId: SETUP_ID,
    content: {
      primaryClass: personalRef('Synthetic class'), secondaryClass: personalRef('Synthetic sub-command'),
      equipment: { [source.slots[0]!.id]: { ref: personalRef('Synthetic sword') } },
      passives: [{ ref: personalRef('Synthetic focus') }, { ref: personalRef('Synthetic conflicting passive') }], contextAssumptions: [],
    },
    now: TEST_NOW,
  })
}
