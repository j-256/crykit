// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { STARTER_CATALOG } from '../catalog/starter'
import { createBuild, saveBuildRevision } from '../domain/builds'
import { SUGGESTED_BUILD_SLOTS } from '../domain/build-planning'
import { saveSharedTeam, teamSlots, withTeamBuildViews } from '../domain/team-checkpoints'
import { saveTeam } from '../domain/teams'
import { saveTeamMember } from '../domain/team-member'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID, TEST_NOW } from '../domain/test-helpers'
import type { CatalogRef, LocalData, TeamRevision } from '../domain/types'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { DefinitionProvider } from './definitions'
import { NavigationProvider, type NavigationController } from './navigation'
import { TeamOverview } from './TeamOverview'
import { TeamsView } from './TeamsView'

const lock = { [STARTER_CATALOG.id]: STARTER_CATALOG.revisionId }
const sword: CatalogRef = { kind: 'catalog', catalogId: STARTER_CATALOG.id, catalogRevisionId: STARTER_CATALOG.revisionId, entityId: Object.values(STARTER_CATALOG.entities).find(entity => entity.name === 'Broadsword')!.id }
const checkpoint = (data: LocalData): TeamRevision => { const team = data.teams.team!; if (team.kind !== 'shared') throw new Error('Expected shared Team'); return data.teamRevisions[team.latestRevisionId]! }
function fixture(retained: boolean, emptyLayout = false) {
  const initial = createTestLocalData(), setup = initial.gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  const data = { ...initial, gameSetups: { ...initial.gameSetups, [setup.id]: { ...setup, slots: emptyLayout ? [] : SUGGESTED_BUILD_SLOTS, catalogLock: retained ? lock : {} }, alternative: { ...setup, id: 'alternative' as never, label: 'Explicit alternative', slots: SUGGESTED_BUILD_SLOTS, catalogLock: retained ? lock : {} } } }
  const source = saveBuildRevision(createBuild(data, { id: 'source' as never, title: 'Source Build', gameSetupId: setup.gameSetupId }), { id: 'source-revision' as never, buildId: 'source' as never, gameSetupRevisionId: setup.id, catalogLock: lock, content: { primaryClass: null, secondaryClass: null, equipment: emptyLayout ? {} : { 'plan-main-hand': { ref: sword } }, passives: [], contextAssumptions: [] } })
  const saved = saveSharedTeam(source, { id: 'team' as never, title: 'Exact context', gameSetupRevisionId: setup.id, catalogLock: retained ? {} : lock, slots: emptyLayout ? [{ id: 'owned' as never, createdAt: TEST_NOW, content: { ...source.buildRevisions['source-revision']!.content, equipment: { 'plan-main-hand': { ref: sword } } } }, null, null, null] : ['source-revision' as never, null, null, null] })
  validateNativeLocalDataGraph(saved, [STARTER_CATALOG])
  return saved
}
let root: Root, container: HTMLDivElement
beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })
async function click(name: string) { const button = [...container.querySelectorAll('button')].find(button => button.textContent === name); expect(button).toBeDefined(); await act(async () => button!.click()) }

for (const retained of [true, false]) it(`preserves the actual editor and member context with a ${retained ? 'retained' : 'compatible'} independently pinned checkpoint`, async () => {
  let data = fixture(retained)
  const before = structuredClone(data)
  const navigation = { route: { page: { page: 'teams', view: 'edit', teamId: 'team' }, overlays: [], query: {} }, registerBlocker: () => () => undefined, navigate: vi.fn() } as unknown as NavigationController
  const show = () => root.render(<NavigationProvider controller={navigation}><DefinitionProvider localData={data} catalogs={[STARTER_CATALOG]} onSaveDefinition={async () => { throw new Error('Unexpected definition save') }}><TeamsView localData={data} catalogs={[STARTER_CATALOG]} onDraftChange={() => undefined} onSave={async input => { data = saveTeam(data, input); show(); return 'team' as never }} onSaveMember={async input => { data = saveTeamMember(data, { ...input, revisionId: 'unused' as never }, [STARTER_CATALOG]); show(); return { buildId: 'team' as never, revisionId: teamSlots(data, data.teams.team!)[0]! } }} onSaveAsBuild={async () => undefined} onAdopt={async () => undefined} onDelete={async () => undefined}/></DefinitionProvider></NavigationProvider>)
  await act(async () => show())
  const card = () => container.querySelector('[aria-label="Team slot 1 loadout"]')!
  expect(card().textContent!.includes('Recorded selections outside this Game Setup')).toBe(retained)
  expect(card().textContent!.includes('Occupied by Broadsword')).toBe(!retained)
  await click('Edit member')
  expect(container.textContent!.includes("outside the build's pinned catalog revision")).toBe(retained)
  expect(container.textContent!.includes('occupied by Broadsword')).toBe(!retained)
  await click('Checks & notes')
  const notes = container.querySelector('textarea')!
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(notes, 'Changed Team note'); notes.dispatchEvent(new Event('input', { bubbles: true })) })
  await click('Save member and return to Team')
  const saved = checkpoint(data)
  expect(saved.id).not.toBe(checkpoint(before).id)
  expect(saved.catalogLock).toEqual(checkpoint(before).catalogLock)
  expect(saved.slots[0]!.content.retainedSelections).toEqual(checkpoint(before).slots[0]!.content.retainedSelections)
  expect(saved.slots[0]!.content.rotationNotes).toBe('Changed Team note')
  expect(data.gameSetups).toEqual(before.gameSetups)
  expect(data.builds).toEqual(before.builds); expect(data.buildRevisions).toEqual(before.buildRevisions)
  expect(data.teamRevisions[checkpoint(before).id]).toEqual(checkpoint(before))
  validateNativeLocalDataGraph(data, [STARTER_CATALOG])
  const choose = [...container.querySelectorAll('select')].find(select => select.options[0]?.text === 'Choose a shared Game Setup')!
  await act(async () => { choose.value = 'alternative'; choose.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(card().textContent!.includes('Recorded selections outside this Game Setup')).toBe(!retained)
  await click('Save Team')
  expect(checkpoint(data).catalogLock).toEqual(before.gameSetups.alternative!.catalogLock)
  expect(Boolean(checkpoint(data).slots[0]!.content.retainedSelections)).toBe(!retained)
  expect(data.teamRevisions[saved.id]).toEqual(saved)
  validateNativeLocalDataGraph(data, [STARTER_CATALOG])
})

it('compact cards retain source names but gate two-handed occupancy and honor an exact empty slot layout', () => {
  const render = (data: LocalData) => renderToStaticMarkup(<TeamOverview compact localData={withTeamBuildViews(data)} catalogs={[STARTER_CATALOG]} slots={teamSlots(data, data.teams.team!)}/>)
  const valid = render(fixture(false))
  expect(valid).toContain('Off hand: Occupied by Broadsword')
  const unresolved = render(fixture(true))
  expect(unresolved).toContain('Broadsword')
  expect(unresolved).toContain('Unresolved checks')
  expect(unresolved).not.toContain('Off hand: Occupied by Broadsword')
  const empty = render(fixture(false, true))
  expect(empty).not.toContain('Off hand: Occupied by Broadsword')
  expect(empty).toContain('No selection')
})
