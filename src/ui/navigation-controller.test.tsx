import { act, StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBlankLocalData } from '../domain'
import { DefinitionEditor, DefinitionProvider } from './definitions'
import { NavigationProvider, parseAppRoute, routeWithOverlay, useNavigation, useNavigationController, type NavigationController } from './navigation'
import type { EntityRouteNameResolver } from './entity-route-names'
import { Sheet } from './Sheet'

let container: HTMLDivElement
let controller: NavigationController
let originalClose: typeof HTMLDialogElement.prototype.close
let originalShowModal: typeof HTMLDialogElement.prototype.showModal
let shownLayers: number[]

function tick() {
  return new Promise((resolve) => window.setTimeout(resolve, 10))
}

function Harness({ block = false, resolveEntityName }: { block?: boolean; resolveEntityName?: EntityRouteNameResolver }) {
  const navigation = useNavigationController({ resolveEntityName, shouldBlock: () => block })
  controller = navigation
  return <NavigationProvider controller={navigation}><Draft/></NavigationProvider>
}

function Draft() {
  const navigation = useNavigation()
  const [draft, setDraft] = useState('retained')
  const pickerOpen = navigation.route.overlays.at(-1)?.kind === 'definition-picker'
  return <><button id="change-draft" onClick={() => setDraft('changed')} type="button">Change</button><output id="draft">{draft}</output><Sheet onClose={() => navigation.close()} open={pickerOpen} title="Choose definition"><p>Picker</p></Sheet></>
}

function ReversedLayerSheets({ onChildClose }: { onChildClose: () => void }) {
  return <><Sheet layer={1} onClose={onChildClose} open title="Child search"><p>Child</p></Sheet><Sheet layer={0} onClose={() => undefined} open title="Parent settings"><p>Parent</p></Sheet></>
}

function LateParentSheets({ parent }: { parent: boolean }) {
  return <><Sheet layer={1} onClose={() => undefined} open title="Existing search"><p>Child</p></Sheet>{parent && <Sheet layer={0} onClose={() => undefined} open title="Later settings"><p>Parent</p></Sheet>}</>
}

function MissingDefinitionHarness() {
  const navigation = useNavigationController()
  const editorIndex = navigation.route.overlays.findIndex((overlay) => overlay.kind === 'definition-editor')
  return <NavigationProvider controller={navigation}><DefinitionProvider catalogs={[]} onSaveDefinition={() => Promise.reject(new Error('Unexpected save'))} localData={createBlankLocalData()}><DefinitionEditor allowedKinds={['item']} onClose={() => navigation.close()} onSaved={() => undefined} open routeIndex={editorIndex}/></DefinitionProvider></NavigationProvider>
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '#/inventory')
  originalClose = HTMLDialogElement.prototype.close
  originalShowModal = HTMLDialogElement.prototype.showModal
  shownLayers = []
  HTMLDialogElement.prototype.showModal = function showModal() { shownLayers.push(Number(this.dataset.sheetLayer)); this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function close() { this.removeAttribute('open'); window.queueMicrotask(() => this.dispatchEvent(new Event('close'))) }
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  HTMLDialogElement.prototype.close = originalClose
  HTMLDialogElement.prototype.showModal = originalShowModal
  container.remove()
  document.body.replaceChildren()
})

describe('navigation controller history', () => {
  it('normalizes descriptive slugs without adding history and refreshes imported names after loading', async () => {
    const hash = '#/reference/catalog/synthetic/revisions/r1/entities/id/foreign%3A1/incorrect-name'
    window.history.replaceState({ retained: true }, '', hash)
    const length = window.history.length
    const root = createRoot(container)
    await act(async () => { root.render(<Harness resolveEntityName={() => undefined}/>); await tick() })
    expect(window.location.hash).toBe(hash.replace('incorrect-name', 'definition'))
    const exact = controller.route
    await act(async () => { root.render(<Harness resolveEntityName={() => 'Synthetic imported name'}/>); await tick() })
    expect(window.location.hash).toBe(hash.replace('incorrect-name', 'synthetic-imported-name'))
    expect(window.history.length).toBe(length)
    expect(window.history.state.retained).toBe(true)
    expect(controller.route).toEqual(exact)
    expect(controller.href(exact)).toBe(window.location.hash)
    await act(async () => {
      window.location.hash = hash.replace('incorrect-name', 'another-wrong-name')
      await tick()
    })
    expect(window.location.hash).toBe(hash.replace('incorrect-name', 'synthetic-imported-name'))
    expect(controller.route).toEqual(exact)
    expect(window.history.length).toBe(length + 1)
    await act(async () => root.unmount())
  })

  it('protects query-selected editors while allowing navigation after their draft is resolved', async () => {
    const root = createRoot(container)
    const scope = parseAppRoute('#/settings/game-setup?gameSetup=synthetic-source')
    await act(async () => { root.render(<Harness/>); await tick() })
    await act(async () => { controller.navigate(scope) })
    let dirty = true
    const unregister = controller.registerBlocker({ scope, matchQuery: true, blocked: () => dirty })
    await act(async () => {
      expect(controller.navigate(scope)).toBe(true)
      expect(controller.navigate(parseAppRoute('#/settings/game-setup'))).toBe(false)
      expect(controller.navigate(parseAppRoute('#/settings/game-setup?gameSetup=synthetic-other'))).toBe(false)
    })
    expect(controller.route).toEqual(scope)
    dirty = false
    await act(async () => { expect(controller.navigate(parseAppRoute('#/settings/game-setup'))).toBe(true) })
    unregister()
    await act(async () => root.unmount())
  })

  it('reports drafts for context changes even when navigation stays inside their scope', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(<Harness/>); await tick() })
    let dirty = true
    const unregister = controller.registerBlocker({ scope: controller.route, blocked: () => dirty })
    expect(controller.hasOpenDraft()).toBe(true)
    await act(async () => { expect(controller.navigate(controller.route)).toBe(true) })
    expect(controller.hasOpenDraft()).toBe(true)
    dirty = false
    expect(controller.hasOpenDraft()).toBe(false)
    dirty = true
    unregister()
    expect(controller.hasOpenDraft()).toBe(false)
    await act(async () => root.unmount())
  })

  it('opens direct-linked sheets in semantic parent-to-child order regardless of render order', async () => {
    const root = createRoot(container)
    let childClosed = 0
    await act(async () => { root.render(<ReversedLayerSheets onChildClose={() => { childClosed += 1 }}/>); await tick() })
    expect(shownLayers).toEqual([0, 1])
    const child = [...document.querySelectorAll<HTMLDialogElement>('dialog')].find((dialog) => dialog.getAttribute('aria-labelledby') && dialog.textContent?.includes('Child search'))!
    await act(async () => { child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick() })
    expect(childClosed).toBe(1)
    expect([...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].map((dialog) => dialog.dataset.sheetLayer)).toContain('0')
    await act(async () => root.unmount())
  })

  it('reorders an existing child when its lower route layer mounts later', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(<LateParentSheets parent={false}/>); await tick() })
    expect(shownLayers).toEqual([1])
    await act(async () => { root.render(<LateParentSheets parent/>); await tick() })
    expect(shownLayers.slice(-2)).toEqual([0, 1])
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(2)
    await act(async () => root.unmount())
  })

  it('closes one nested sheet per request, preserves its parent draft, and reopens on Forward', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(<StrictMode><Harness/></StrictMode>); await tick() })
    await act(async () => { controller.navigate({ page: { page: 'inventory', view: 'new' }, overlays: [], query: {} }) })
    await act(async () => { controller.navigate(routeWithOverlay(controller.route, { kind: 'definition-picker', fieldKey: 'item-definition', query: '', resultLimit: 100 })) })
    await act(async () => { document.querySelector<HTMLButtonElement>('#change-draft')!.click() })
    expect(window.location.hash).toContain('/pick/item-definition')

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Close dialog"]')!.click()
      await tick()
    })
    expect(window.location.hash).toBe('#/inventory/new')
    expect(document.querySelector('#draft')?.textContent).toBe('changed')

    await act(async () => { window.history.forward(); await tick() })
    expect(window.location.hash).toContain('/pick/item-definition')
    expect(document.querySelector('#draft')?.textContent).toBe('changed')
    await act(async () => root.unmount())
  })

  it('returns to the accepted entry when Back is rejected without accepting the attempted route', async () => {
    const root = createRoot(container)
    await act(async () => root.render(<Harness/>))
    await act(async () => {
      controller.navigate({ page: { page: 'characters', view: 'list' }, overlays: [], query: {} })
    })
    await act(async () => root.render(<Harness block/>))
    expect(window.location.hash).toBe('#/characters')
    await act(async () => { window.history.back(); await tick(); await tick() })
    expect(window.location.hash).toBe('#/characters')
    expect(controller.route.page).toEqual({ page: 'characters', view: 'list' })
    await act(async () => root.unmount())
  })

  it('returns to an accepted direct hash when Back is rejected', async () => {
    const root = createRoot(container)
    await act(async () => { root.render(<Harness/>); await tick() })
    await act(async () => {
      window.location.hash = '/reference/search/definitions/new'
      await tick()
    })
    await act(async () => root.render(<Harness block/>))
    expect(window.location.hash).toBe('#/reference/search/definitions/new')

    await act(async () => { window.history.back(); await tick(); await tick() })

    expect(window.location.hash).toBe('#/reference/search/definitions/new')
    expect(controller.route).toMatchObject({ page: { page: 'reference', view: 'list' }, overlays: [{ kind: 'search' }, { kind: 'definition-editor', mode: 'new' }] })
    await act(async () => root.unmount())
  })

  it('shows recovery instead of an editor for a missing exact override', async () => {
    window.history.replaceState(null, '', '#/inventory/new/pick/item-definition/definitions/override/personal/missing')
    const root = createRoot(container)
    await act(async () => { root.render(<MissingDefinitionHarness/>); await tick() })

    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]')!
    expect(dialog.textContent).toContain('Definition could not be opened')
    expect(dialog.querySelector('input, textarea, select')).toBeNull()
    expect([...dialog.querySelectorAll('button')].some((button) => button.textContent?.includes('Save new override'))).toBe(false)
    await act(async () => root.unmount())
  })
})
