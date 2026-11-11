// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import type { EntityRef } from '../domain/types'
import { BuildMechanics } from './BuildMechanics'
import { DefinitionProvider } from './definitions'

vi.mock('./CalculationPicker', async () => {
  const { useDefinitionLibrary } = await import('./definitions')
  return { CalculationPicker: ({ value, onChange }: { value: EntityRef | null; onChange: (ref: EntityRef | null) => void }) => {
    const library = useDefinitionLibrary()
    const ability = library.planningOptions.find(option => option.name === 'Steal' && option.kind === 'ability')
    return <button data-selected={JSON.stringify(value)} data-setup={library.localData.planningGameSetupRevisionId} onClick={() => onChange(ability?.ref ?? null)}>Choose test ability</button>
  } }
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

it('isolates read-only preview choices from the active library and discards experiments on a different source', async () => {
  const localData = createSampleLocalData(CURRENT_CATALOG)
  const build = Object.values(localData.builds).find(build => build.title === 'Tavi: sample Rogue')!
  const revision = localData.buildRevisions[build.latestRevisionId!]!
  const setup = localData.gameSetups[revision.gameSetupRevisionId]!
  const original = structuredClone(revision.content)
  const write = vi.fn(async (): Promise<EntityRef> => { throw new Error('Unexpected definition write') })
  const render = (content = revision.content) => <DefinitionProvider localData={localData} catalogs={[]} onSaveDefinition={write}><BuildMechanics content={content} slots={setup.slots} gameSetup={setup} localData={localData} catalogs={[CURRENT_CATALOG]}/></DefinitionProvider>
  await act(async () => root.render(render()))
  const choose = () => container.querySelector<HTMLButtonElement>('[data-selected]')!
  expect(choose().dataset.setup).toBe(setup.id)
  await act(async () => choose().click())
  const selected = JSON.parse(choose().dataset.selected!) as EntityRef
  expect(selected).toMatchObject({ kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId })
  expect(container.querySelector('[aria-label="Effective ability costs"]')).not.toBeNull()
  expect(revision.content).toEqual(original)
  const reset = [...container.querySelectorAll('button')].find(button => button.textContent === 'Reset preview')!
  await act(async () => reset.click())
  expect(choose().dataset.selected).toBe('null')
  await act(async () => choose().click())
  await act(async () => root.render(render({ ...revision.content, rotationNotes: 'A different source checkpoint' })))
  expect(choose().dataset.selected).toBe('null')
  expect(write).not.toHaveBeenCalled()
  expect(revision.content).toEqual(original)
})
