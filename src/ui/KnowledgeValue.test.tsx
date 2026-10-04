import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Sources } from './Sources'
import { DefinitionClaimsPanel, DefinitionFactsPanel, DefinitionSourcesPanel } from './DefinitionDetailSections'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import type { EntityId } from '../domain/types'
import { KnowledgeValue } from './KnowledgeValue'
import { definitionIconKey, fieldIconKey, fieldIconKeys } from '../catalog/menu-icons'

const mounts: { root: Root; container: HTMLDivElement }[] = []
const prototypeMethods = ['showPopover', 'hidePopover', 'scrollIntoView'] as const
let originalMethods: (PropertyDescriptor | undefined)[]

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const open = new WeakSet<HTMLElement>()
  originalMethods = prototypeMethods.map(name => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: function (this: HTMLElement) { open.add(this) } },
    hidePopover: { configurable: true, value: function (this: HTMLElement) { open.delete(this) } },
    scrollIntoView: { configurable: true, value: vi.fn() },
  })
  const matches = HTMLElement.prototype.matches
  vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (this: HTMLElement, selector) { return selector === ':popover-open' ? open.has(this) : matches.call(this, selector) })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { callback(performance.now()); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})

afterEach(async () => {
  for (const { root, container } of mounts.splice(0)) {
    await act(async () => root.unmount())
    container.remove()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const [index, name] of prototypeMethods.entries()) {
    const descriptor = originalMethods[index]
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor)
    else Reflect.deleteProperty(HTMLElement.prototype, name)
  }
})

async function renderInteractive(children: ReactNode) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounts.push({ root, container })
  await act(async () => root.render(children))
  return container
}

async function openSources(container: HTMLElement, label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  expect(trigger).not.toBeNull()
  await act(async () => trigger.click())
  const popup = container.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`)!
  expect(popup).not.toBeNull()
  return popup
}

async function closeSources(popup: HTMLElement) {
  await act(async () => popup.querySelector<HTMLButtonElement>('button[aria-label="Close sources"]')!.click())
}

describe('source claim presentation', () => {
  it('shows structured values, notes and source revisions while treating markup and unsafe URLs as text', async () => {
    const container = await renderInteractive(<KnowledgeValue value={{ state: 'conflicting', claims: [
      { value: '<script>untrusted()</script>', note: 'Synthetic disputed description', sources: [{ sourceId: 'javascript:untrusted()', locator: 'data:text/html,untrusted' }] },
      { value: [{ shop: 'Synthetic shop', cost: 0, restricted: false }], sources: [{ sourceId: 'https://example.com/wiki?oldid=1', locator: 'Item > Location', snapshot: 'revision 1', applicability: 'Synthetic release' }] },
    ] }}/>)
    expect(container.querySelectorAll('.knowledge-claim')).toHaveLength(2)
    expect(container.textContent).toContain('<script>untrusted()</script>')
    expect(container.textContent).toContain('Synthetic disputed description')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    const unsafe = await openSources(container, 'Sources for claim 1')
    expect(unsafe.textContent).toContain('javascript:untrusted()')
    expect(unsafe.textContent).toContain('data:text/html,untrusted')
    expect(unsafe.querySelector('a')).toBeNull()
    expect(container.querySelectorAll('script')).toHaveLength(0)
    await closeSources(unsafe)
    const attributed = await openSources(container, 'Sources for claim 2')
    expect(attributed.textContent).toContain('revision 1')
    expect(attributed.textContent).toContain('Synthetic release')
    expect([...attributed.querySelectorAll('a')].map((link) => link.href)).toEqual(['https://example.com/wiki?oldid=1'])
    expect(container.querySelectorAll('script')).toHaveLength(0)
    expect([...container.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['Synthetic shop', '0', 'false'])
  })
})

describe('native and external source details', () => {
  const native = { sourceId: 'native-game:windows:1.6.9', locator: 'Database/job.dat record 7', snapshot: 'Synthetic database fingerprint' }
  const wiki = { sourceId: 'https://example.test/wiki/Synthetic', locator: 'Community table' }

  it('keeps known native values visible without a marker and cites only external evidence for mixed values', async () => {
    const sources = [native, wiki]
    const container = await renderInteractive(<><KnowledgeValue field="Native" showSources value={{ state: 'known', value: 80, sources: [native] }}/><KnowledgeValue field="Mixed" showSources value={{ state: 'known', value: 90, sources }}/></>)
    expect(container.textContent).toContain('80')
    expect(container.textContent).toContain('90')
    expect(container.querySelector('button[aria-label="Sources for Native"]')).toBeNull()
    const popup = await openSources(container, 'Sources for Mixed')
    expect(popup.textContent).toContain(wiki.locator)
    expect(popup.textContent).not.toContain(native.locator)
    expect(sources).toEqual([native, wiki])
  })

  it('retains native evidence for unknown values and competing claims', async () => {
    const container = await renderInteractive(<><KnowledgeValue field="Unconfirmed" showSources value={{ state: 'unknown', reason: 'Condition is unconfirmed', sources: [native] }}/><KnowledgeValue field="Disputed" value={{ state: 'conflicting', claims: [{ value: 80, sources: [native] }, { value: 90, sources: [wiki] }] }}/></>)
    expect(container.textContent).toContain('Condition is unconfirmed')
    expect(container.textContent).toContain('2 differing source values')
    for (const [label, locator] of [['Sources for Unconfirmed', native.locator], ['Sources for Disputed 1', native.locator], ['Sources for Disputed 2', wiki.locator]]) {
      const popup = await openSources(container, label!)
      expect(popup.textContent).toContain(locator)
      await closeSources(popup)
    }
  })

  it('discloses only external entity sources unless uncertainty calls for the complete evidence', async () => {
    const container = await renderInteractive(<><DefinitionSourcesPanel anchor={<span>Native gameplay content</span>} label="Sources for native entity" sources={[native]}/><DefinitionSourcesPanel label="Sources for mixed entity" sources={[native, wiki]}/><DefinitionSourcesPanel label="Sources for uncertain entity" sources={[native, wiki]} uncertain><p>Unresolved condition</p></DefinitionSourcesPanel></>)
    expect(container.textContent).toContain('Native gameplay content')
    expect(container.querySelector('button[aria-label="Sources for native entity"]')).toBeNull()
    const mixed = await openSources(container, 'Sources for mixed entity')
    expect(mixed.textContent).toContain(wiki.locator)
    expect(mixed.textContent).not.toContain(native.locator)
    await closeSources(mixed)
    const uncertain = await openSources(container, 'Sources for uncertain entity')
    expect(uncertain.textContent).toContain(wiki.locator)
    expect(uncertain.textContent).toContain(native.locator)
    expect(uncertain.textContent).toContain('Unresolved condition')
  })

  it('retains external evidence for known mixed-source fields', async () => {
    const container = await renderInteractive(<DefinitionFactsPanel facts={[["Master", { state: 'known', value: 'Synthetic mastery reward', sources: [native, wiki] }]]}/>)
    expect(container.textContent).toContain('Synthetic mastery reward')
    const popup = await openSources(container, 'Sources for Master')
    expect(popup.textContent).toContain(wiki.locator)
    expect(popup.textContent).not.toContain(native.locator)
  })

  it('opens the original native evidence for a changed fact that no longer matches its receipt', async () => {
    const baseline = DEFAULT_CATALOG.entities['base:job:0']!
    const original = baseline.fields['Class command']!
    if (original.state !== 'known') throw new Error('The native class command fixture must be known')
    const source = original.sources?.find(source => source.sourceId.startsWith('native-game:'))
    expect(source?.locator).toBeDefined()
    const changed = { ...original, value: 'Synthetic changed command' }
    const entity = { ...baseline, fields: { ...baseline.fields, 'Class command': changed } }
    const container = await renderInteractive(<DefinitionFactsPanel corroboration={{ catalog: DEFAULT_CATALOG, entity }} facts={[["Class command", changed]]}/>)
    expect(container.textContent).toContain('Synthetic changed command')
    expect(container.textContent).not.toContain(source!.locator)
    const popup = await openSources(container, 'Sources for Class command')
    expect(popup.textContent).toContain(source!.locator)
    expect(popup.querySelector('.source-summary')).not.toBeNull()
    await closeSources(popup)
    expect(container.textContent).toContain('Synthetic changed command')
  })

  it('retains unverified export values and original claim evidence when their Sources popup opens', async () => {
    const source = { sourceId: 'native-game:windows:synthetic', locator: 'Database/job.dat record 7', snapshot: 'Synthetic executable fingerprint', applicability: 'Synthetic native release' }
    const container = await renderInteractive(<><KnowledgeValue field="Attack" showSources value={{ state: 'known', value: 80, sources: [source] }}/><Sources label="Sources for original claim"><DefinitionClaimsPanel claims={[{ entityId: 'synthetic-native' as EntityId, field: 'Attack', value: { state: 'known', value: 79 }, sources: [source] }]}/></Sources></>)
    expect(container.textContent).toContain('80')
    expect(container.textContent).not.toContain(source.locator)
    for (const label of ['Sources for Attack', 'Sources for original claim']) {
      const popup = await openSources(container, label)
      expect(popup.textContent).toContain(source.locator)
      expect(popup.textContent).toContain(source.snapshot)
      expect(popup.textContent).toContain(source.applicability)
      if (label === 'Sources for original claim') expect(popup.textContent).toContain('79')
      await closeSources(popup)
    }
    expect(container.textContent).toContain('80')
  })
})

describe('source-backed field icons', () => {
  it('adds weapon and armor icons while retaining every label and unsupported value', () => {
    const markup = renderToStaticMarkup(<KnowledgeValue field="Weapons" value={{ state: 'known', value: 'Swords, Axes, Daggers, Spears, Unconfirmed tool' }}/>)
    const container = document.createElement('div')
    container.innerHTML = markup
    expect(container.textContent).toBe('Swords, Axes, Daggers, Spears, Unconfirmed tool')
    expect(container.querySelectorAll('img')).toHaveLength(4)
    expect([...container.querySelectorAll('img')].every(img => img.alt === '' && !img.src.startsWith('https:'))).toBe(true)
    expect(fieldIconKey('Armor', 'Heavy helmets')).toBe('equipment:heavy helmets')
    expect(fieldIconKey('Weapons', 'Staff')).toBe('equipment:staves')
  })

  it('does not turn an ability name, arbitrary description, or unknown value into an element', () => {
    expect(fieldIconKey('Name', 'Fire')).toBeUndefined()
    expect(fieldIconKey('Description', 'Swords')).toBeUndefined()
    expect(fieldIconKey('Element', 'Fire')).toBe('element:fire')
    const markup = renderToStaticMarkup(<KnowledgeValue field="Weapons" value={{ state: 'unknown', reason: 'Swords unconfirmed' }}/>)
    expect(markup).not.toContain('<img')
    expect(markup).toContain('Swords unconfirmed')
  })

  it('preserves competing field claims and attributes icons in both alternatives', () => {
    const weapons = { state: 'conflicting' as const, claims: [{ value: 'Swords', sources: [] }, { value: ['Axes', 'Unconfirmed'], sources: [] }] }
    const markup = renderToStaticMarkup(<KnowledgeValue field="Weapons" value={weapons}/>)
    expect(markup).toContain('2 differing source values')
    expect(markup).toContain('Unconfirmed')
    expect(fieldIconKeys({ Weapons: weapons })).toEqual(['equipment:swords', 'equipment:axes'])
  })

  it('uses recorded skill types and schools rather than names to choose skill icons', () => {
    const entity = { name: 'Fire', kind: 'ability' as const, fields: {} }
    expect(definitionIconKey(entity)).toBeUndefined()
    expect(definitionIconKey({ ...entity, fields: { Type: { state: 'known', value: 'Single target Rapier/Sword skill' } } })).toBe('skill:rapier/sword skill')
    expect(definitionIconKey({ ...entity, fields: { Category: { state: 'known', value: ['Abilities', 'Black Magic'] } } })).toBe('skill:black magic')
    expect(definitionIconKey({ ...entity, fields: { Category: { state: 'known', value: ['Black Magic', 'White Magic'] } } })).toBeUndefined()
  })
})

describe('coin price presentation', () => {
  it('renders integer money in technical details, including nested records and competing claims', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<><KnowledgeValue field="Native source record" moneyFormat="integer" value={{ state: 'known', value: { Money: 20000, Cost: 250, Actions: [{ Money: 100 }] } }}/><KnowledgeValue field="Money (copper)" moneyFormat="integer" value={{ state: 'conflicting', claims: [{ value: 20000, sources: [] }, { value: 10250, sources: [] }] }}/></>)
    expect(container.querySelectorAll('.money-amount')).toHaveLength(0)
    expect(container.textContent).toContain('Money20000')
    expect(container.textContent).toContain('Cost250')
    expect([...container.querySelectorAll('.knowledge-claim__value')].map(element => element.textContent)).toEqual(['20000', '10250'])
    expect(container.querySelector('td')?.textContent).toBe('100')
  })

  it('formats numeric copper fields and native record prices without changing their values', () => {
    const value = { Money: 20000, Cost: 10250, HP: 20000, Actions: [{ Cost: 100, Weight: 100 }] }
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<><KnowledgeValue field="Native source record" value={{ state: 'known', value }}/><KnowledgeValue field="Money (copper)" value={{ state: 'known', value: 20000 }}/><KnowledgeValue field="Cost (copper)" value={{ state: 'known', value: 0 }}/></>)
    expect([...container.querySelectorAll('.money-amount')].map(element => element.getAttribute('aria-label'))).toEqual(['2 gold', '1 gold, 2 silver, 50 copper', '1 silver', '2 gold', '0 copper'])
    expect(container.textContent).toContain('HP20000')
    expect(container.querySelectorAll('td')[1]?.textContent).toBe('100')
    expect(value.Money).toBe(20000)
    expect(value.Cost).toBe(10250)
  })

  it('retains numeric money conflicts and unknown states without converting unsupported numbers', async () => {
    const container = await renderInteractive(<KnowledgeValue field="Money (copper)" value={{ state: 'conflicting', claims: [{ value: 20000, sources: [{ sourceId: 'Source A' }] }, { value: 10250, sources: [{ sourceId: 'Source B' }] }] }}/>)
    expect(container.querySelectorAll('.knowledge-claim')).toHaveLength(2)
    expect([...container.querySelectorAll('.money-amount')].map(element => element.getAttribute('aria-label'))).toEqual(['2 gold', '1 gold, 2 silver, 50 copper'])
    for (const [index, source] of ['Source A', 'Source B'].entries()) {
      const popup = await openSources(container, `Sources for Money (copper) ${index + 1}`)
      expect(popup.textContent).toContain(source)
      await closeSources(popup)
    }
    expect(renderToStaticMarkup(<KnowledgeValue field="Money (copper)" value={{ state: 'unknown' }}/>)).toBe('<span>Unknown</span>')
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(renderToStaticMarkup(<KnowledgeValue field="Money (copper)" value={{ state: 'known', value }}/>)).toBe(`<span>${value}</span>`)
    }
  })

  it('formats nested shop prices, mixed currencies, and description text while preserving material names', () => {
    const value = [{ Shop: 'Synthetic shop', Cost: '1000 Copper', Recipe: { Price: '1 Gold 2 Silver 50 Copper', Materials: '3 Gold Ore' } }, { Shop: 'Other shop', Cost: 'Unknown', Recipe: 'Costs 760 Silver each' }]
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<KnowledgeValue value={{ state: 'known', value }}/>)
    expect([...container.querySelectorAll('.money-amount')].map(element => element.getAttribute('aria-label'))).toEqual(['10 silver', '1 gold, 2 silver, 50 copper', '7 gold, 60 silver'])
    expect(container.textContent).toContain('3 Gold Ore')
    expect(container.textContent).toContain('Unknown')
    expect(container.textContent).not.toContain('Copper')
    expect(value[0].Cost).toBe('1000 Copper')
  })

  it('retains conflicting values and source evidence when equivalent amounts share the same visual price', async () => {
    const container = await renderInteractive(<KnowledgeValue field="Cost" value={{ state: 'conflicting', claims: [
      { value: '1000 Copper', sources: [{ sourceId: 'Source A' }] },
      { value: '10 Silver', sources: [{ sourceId: 'Source B' }] },
    ] }}/>)
    expect(container.querySelectorAll('.knowledge-claim')).toHaveLength(2)
    expect(container.querySelectorAll('[aria-label="10 silver"]')).toHaveLength(2)
    expect(container.textContent).toContain('2 differing source values')
    for (const [index, source] of ['Source A', 'Source B'].entries()) {
      const popup = await openSources(container, `Sources for Cost ${index + 1}`)
      expect(popup.textContent).toContain(source)
      await closeSources(popup)
    }
  })

  it('keeps unitless and noncurrency costs, unsafe markup, and unknown states explicit', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<KnowledgeValue value={{ state: 'known', value: { Cost: 1000, Skill: '6 MP, 10 CT', Note: '<script>1000 Copper</script>' } }}/>)
    expect(container.textContent).toContain('1000')
    expect(container.textContent).toContain('6 MP, 10 CT')
    expect(container.textContent).toContain('<script>')
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelectorAll('.money-amount')).toHaveLength(1)
    expect(renderToStaticMarkup(<KnowledgeValue field="Cost" value={{ state: 'unknown' }}/>)).toBe('<span>Unknown</span>')
  })
})
