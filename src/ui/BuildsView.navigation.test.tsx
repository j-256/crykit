import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asId, createBlankLocalData } from '../domain'
import { addTestScenario, createTestLocalData, TEST_PLAYTHROUGH_ID } from '../domain/test-helpers'
import type { LocalData, ScenarioId } from '../domain/types'
import { BuildsView } from './BuildsView'
import { DefinitionProvider } from './definitions'
import { NavigationProvider, useNavigationController, type NavigationController } from './navigation'

const PRIVATE_ID = 'synthetic-private-scenario-identifier'
const OTHER_ID = 'synthetic-other-scenario-identifier'
let container: HTMLDivElement
let root: Root
let controller: NavigationController
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let scrolled: HTMLElement[]
let originalScroll: PropertyDescriptor | undefined

function Harness({ data }: { data: LocalData }) {
  const navigation = useNavigationController()
  controller = navigation
  return <NavigationProvider controller={navigation}><DefinitionProvider catalogs={[]} localData={data} onSaveDefinition={async () => { throw new Error('Unexpected definition save') }}><BuildsView catalogs={[]} localData={data} validations={{}} onCreateBuild={async () => { throw new Error('Unexpected build save') }} onCloneBuild={async () => { throw new Error('Unexpected clone') }} onSaveDetails={async () => undefined} onSaveRevision={async () => { throw new Error('Unexpected revision save') }} onCreateScenario={async () => undefined} onAssign={async () => undefined} onRecordCurrent={async () => undefined} onDraftChange={() => undefined}/></DefinitionProvider></NavigationProvider>
}

async function render(data: LocalData) {
  await act(async () => root.render(<StrictMode><Harness data={data}/></StrictMode>))
}

function flushFrames() {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(performance.now())
}

async function openScenario(id: string) {
  await act(async () => { controller.navigate({ page: { page: 'builds', view: 'scenario', scenarioId: asId<ScenarioId>(id) }, overlays: [], query: {} }) })
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '#/builds/teams')
  frames = new Map()
  nextFrame = 0
  scrolled = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id) })
  originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: function (this: HTMLElement, options: ScrollIntoViewOptions) { expect(options).toEqual({ block: 'start' }); scrolled.push(this) } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScroll)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})

describe('scenario navigation attribution', () => {
  it('keeps persisted scenario identities out of element IDs and classes while scrolling the requested card', async () => {
    const data = addTestScenario(addTestScenario(createTestLocalData(), {}, PRIVATE_ID), {}, OTHER_ID)
    await render(data)
    await openScenario(PRIVATE_ID)
    flushFrames()
    const cards = [...container.querySelectorAll<HTMLElement>('.scenario-card')]
    expect(cards).toHaveLength(2)
    expect(scrolled).toEqual([cards[0]])
    expect(cards[0]!.querySelector('h2')!.textContent).toContain(PRIVATE_ID)
    for (const element of container.querySelectorAll('[id], [class]')) {
      expect(`${element.id} ${element.getAttribute('class')}`).not.toContain(PRIVATE_ID)
      expect(`${element.id} ${element.getAttribute('class')}`).not.toContain(OTHER_ID)
    }
    await openScenario(OTHER_ID)
    flushFrames()
    expect(scrolled.at(-1)).toBe(cards[1])
    expect(controller.route.page).toMatchObject({ view: 'scenario', scenarioId: OTHER_ID })
    const playthrough = data.playthroughs[TEST_PLAYTHROUGH_ID]!
    await render({ ...data, playthroughs: { ...data.playthroughs, [TEST_PLAYTHROUGH_ID]: { ...playthrough, scenarios: Object.fromEntries(Object.entries(playthrough.scenarios).reverse()) } } })
    flushFrames()
    expect(container.querySelector('.scenario-card')).toBe(cards[1])
    expect(scrolled.at(-1)).toBe(cards[1])
  })

  it('cancels queued scrolling when the view unmounts', async () => {
    await render(addTestScenario(createTestLocalData(), {}, PRIVATE_ID))
    await openScenario(PRIVATE_ID)
    expect(frames.size).toBeGreaterThan(0)
    await act(async () => root.unmount())
    expect(frames.size).toBe(0)
    flushFrames()
    expect(scrolled).toEqual([])
    root = createRoot(container)
  })

  it('cancels stale navigation frames when the route or selected Playthrough changes', async () => {
    const data = addTestScenario(createTestLocalData(), {}, PRIVATE_ID)
    await render(data)
    await openScenario(PRIVATE_ID)
    await act(async () => { controller.navigate({ page: { page: 'builds', view: 'teams' }, overlays: [], query: {} }) })
    flushFrames()
    expect(scrolled).toEqual([])
    await openScenario(PRIVATE_ID)
    await render(createBlankLocalData())
    flushFrames()
    expect(scrolled).toEqual([])
    expect(container.querySelector('.scenario-card')).toBeNull()
    expect(container.textContent).toContain('Party plan unavailable')
    await render(data)
    flushFrames()
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0]!.isConnected).toBe(true)
    const replacement = { ...data, playthroughs: { ...data.playthroughs, [TEST_PLAYTHROUGH_ID]: { ...data.playthroughs[TEST_PLAYTHROUGH_ID]!, scenarios: {} } } }
    await render(replacement)
    flushFrames()
    expect(scrolled).toHaveLength(1)
  })
})
