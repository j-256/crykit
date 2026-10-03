import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_CATALOGS, DEFAULT_CATALOG } from '../catalog/bundled'
import { SUMMONS, type SummonId } from '../catalog/summons'
import { requirePlaythrough, upsertProgress } from '../domain'
import { toggleSummonProgress } from '../domain/summons'
import { createTestLocalData } from '../domain/test-helpers'
import type { EntityId, LocalData } from '../domain/types'
import { NavigationProvider, useNavigationController } from './navigation'
import { summonEntries, SummonsView, type SummonsViewProps } from './SummonsView'

const SHAKU = 'base:ability:223' as const
const PAH = 'base:ability:234' as const
const PINGA = 'base:ability:230' as const
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function Harness(props: SummonsViewProps) {
  const navigation = useNavigationController()
  return <NavigationProvider controller={navigation}><SummonsView {...props}/></NavigationProvider>
}

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '#/progress/summons')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(localData: LocalData, onToggle: SummonsViewProps['onToggle']) {
  await act(async () => root.render(<Harness catalogs={BUNDLED_CATALOGS} key={localData.selectedPlaythroughId} localData={localData} onToggle={onToggle}/>))
}

const button = (id: SummonId) => container.querySelector<HTMLButtonElement>(`[data-summon="${id}"] button`)!

describe('Summons board', () => {
  it('omits passive nodes and preserves the native tree shape with Pinga permanently gold', async () => {
    const onToggle = vi.fn(async () => undefined)
    await render(createTestLocalData(), onToggle)
    const tiles = container.querySelectorAll<HTMLLIElement>('.summon-tile')
    expect(tiles).toHaveLength(SUMMONS.length)
    expect([...tiles].map(tile => [tile.style.gridRow, tile.style.gridColumn])).toEqual([['1', '1'], ['1', '4'], ['2', '1'], ['2', '2'], ['2', '3'], ['2', '4'], ['3', '2'], ['3', '3'], ['4', '2'], ['4', '3']])
    expect([...tiles].filter(tile => tile.dataset.unlocked === 'true').map(tile => tile.dataset.summon)).toEqual([PINGA])
    expect(button(PINGA).disabled).toBe(true)
    expect(button(PINGA).getAttribute('aria-label')).toBe('Pinga, Deity of Healing: Always unlocked')
    expect(container.querySelector('.progress-summary__number')?.textContent).toBe(`1 / ${SUMMONS.length}`)
    await act(async () => button(PINGA).click())
    expect(onToggle).not.toHaveBeenCalled()
    expect(button(PINGA).getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).not.toContain('Initial Resist')
    expect(container.textContent).toContain('Coyote, Deity of The Deep')
    expect(container.querySelectorAll('[data-artwork-source="native"]')).toHaveLength(SUMMONS.length)
  })

  it('keeps the final odd and even toggles visible through intermediate saves without changing neighboring tiles', async () => {
    let saved = createTestLocalData()
    const requests: { id: SummonId; resolve: () => void }[] = []
    const onToggle = (id: SummonId) => new Promise<void>(resolve => requests.push({ id, resolve }))
    await render(saved, onToggle)
    const neighbor = button(PAH)
    const mutations: MutationRecord[] = []
    const observer = new MutationObserver(records => mutations.push(...records))
    observer.observe(neighbor, { attributes: true, childList: true, subtree: true })
    await act(async () => {
      button(SHAKU).click()
      button(SHAKU).click()
      button(SHAKU).click()
    })
    expect(requests.map(request => request.id)).toEqual([SHAKU, SHAKU, SHAKU])
    for (const request of requests) {
      const entry = summonEntries(saved, BUNDLED_CATALOGS).find(entry => entry.summon.id === request.id)!
      saved = toggleSummonProgress(saved, { summonId: entry.summon.id, subject: entry.subject, displayName: entry.summon.label, playthroughId: requirePlaythrough(saved).id })
      await act(async () => { root.render(<Harness catalogs={BUNDLED_CATALOGS} key={saved.selectedPlaythroughId} localData={saved} onToggle={onToggle}/>); request.resolve() })
      expect(button(SHAKU).getAttribute('aria-pressed')).toBe('true')
      expect(button(SHAKU).disabled).toBe(false)
    }
    expect(button(SHAKU).getAttribute('aria-busy')).toBe(null)
    await act(async () => { button(SHAKU).click(); button(SHAKU).click() })
    expect(button(SHAKU).getAttribute('aria-pressed')).toBe('true')
    for (const request of requests.slice(3)) {
      const entry = summonEntries(saved, BUNDLED_CATALOGS).find(entry => entry.summon.id === request.id)!
      saved = toggleSummonProgress(saved, { summonId: entry.summon.id, subject: entry.subject, displayName: entry.summon.label, playthroughId: requirePlaythrough(saved).id })
      await act(async () => { root.render(<Harness catalogs={BUNDLED_CATALOGS} key={saved.selectedPlaythroughId} localData={saved} onToggle={onToggle}/>); request.resolve() })
      expect(button(SHAKU).getAttribute('aria-pressed')).toBe('true')
    }
    expect(button(SHAKU).getAttribute('aria-busy')).toBe(null)
    observer.disconnect()
    expect(button(PAH)).toBe(neighbor)
    expect(mutations).toHaveLength(0)
  })

  it('shows imported uncertainty until confirmation and rolls a failed toggle back before retry', async () => {
    const subject = { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: SHAKU as EntityId }
    const localData = upsertProgress(createTestLocalData(), { subject, displayName: 'Imported summon', unlocked: { state: 'unknown' } })
    const onToggle = vi.fn(async () => { throw new Error('Synthetic storage failure') })
    await render(localData, onToggle)
    expect(button(SHAKU).textContent).toContain('Needs confirmation')
    await act(async () => button(SHAKU).click())
    expect(container.textContent).toContain('Summon not saved')
    expect(button(SHAKU).getAttribute('aria-pressed')).toBe('false')
    expect(button(SHAKU).textContent).toContain('Needs confirmation')
    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry summon')!
    expect(retry.disabled).toBe(false)
    await act(async () => retry.click())
    expect(onToggle).toHaveBeenCalledTimes(2)
  })
})
