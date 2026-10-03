import { savedCatalogVersion } from '../domain/legacy-definition.test-helpers'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_CATALOGS, DEFAULT_CATALOG } from '../catalog/bundled'
import { setAcquisitionProgress, upsertProgress } from '../domain'
import { createTestLocalData } from '../domain/test-helpers'
import type { Knowledge, LocalData } from '../domain/types'
import { NavigationProvider, useNavigationController } from './navigation'
import { TravelUnlocksView, travelUnlockEntries, type TravelUnlocksViewProps } from './TravelUnlocksView'

const SUBJECT = { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: DEFAULT_CATALOG.entities['base:item:196']!.id }

function Harness(props: TravelUnlocksViewProps) {
  const navigation = useNavigationController()
  return <NavigationProvider controller={navigation}><TravelUnlocksView {...props}/></NavigationProvider>
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  window.history.replaceState(null, '', '#/progress/unlocks')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function render(localData: LocalData, onSetAcquired: TravelUnlocksViewProps['onSetAcquired']) {
  await act(async () => root.render(<Harness catalogs={BUNDLED_CATALOGS} localData={localData} onSetAcquired={onSetAcquired} saveBlocked={false}/>))
}

describe('travel acquisition certainty and identity', () => {
  it('keeps acquisition records attached to their exact catalog revision', () => {
    const other = { ...SUBJECT, catalogRevisionId: 'synthetic-other-revision' as typeof SUBJECT.catalogRevisionId }
    const catalog = { ...DEFAULT_CATALOG, revisionId: other.catalogRevisionId }
    let localData = setAcquisitionProgress(createTestLocalData(), { subject: other, displayName: 'Treasure Finder', acquired: true })
    localData = setAcquisitionProgress(localData, { subject: SUBJECT, displayName: 'Treasure Finder', acquired: false })
    const before = JSON.stringify(localData)
    const entries = travelUnlockEntries(localData, [...BUNDLED_CATALOGS, catalog]).filter(entry => entry.name === 'Treasure Finder')
    expect(entries).toEqual([expect.objectContaining({ subject: SUBJECT, state: { state: 'known', value: false } })])
    expect(JSON.stringify(localData)).toBe(before)
  })

  it.each<Knowledge<boolean>>([
    { state: 'unknown' },
    { state: 'conflicting', claims: [{ value: true, sources: [] }, { value: false, sources: [] }] },
    { state: 'notApplicable' },
  ])('shows $state imports as unconfirmed and offers explicit not-acquired confirmation', async collection => {
    const localData = upsertProgress(createTestLocalData(), { subject: SUBJECT, displayName: 'Treasure Finder', collection })
    const onSetAcquired = vi.fn(async () => undefined)
    await render(localData, onSetAcquired)
    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="Treasure Finder: acquired"]')!
    const tile = checkbox.closest('.unlock-tile')!
    expect(checkbox.indeterminate).toBe(true)
    expect(checkbox.getAttribute('aria-checked')).toBe('mixed')
    expect(tile.textContent).toContain('Acquisition needs confirmation')
    expect(tile.textContent).not.toContain('Not acquired')
    expect(container.querySelector('[aria-label="Travel and unlock totals"]')?.textContent).toContain('1 imported observations need confirmation')
    const confirm = [...tile.querySelectorAll('button')].find(button => button.textContent === 'Mark not acquired')!
    await act(async () => confirm.click())
    expect(onSetAcquired).toHaveBeenCalledWith(SUBJECT, 'Treasure Finder', false)
  })

  it('links to a preferred personal definition while retaining the existing acquisition subject', async () => {
    let localData = setAcquisitionProgress(createTestLocalData(), { subject: SUBJECT, displayName: 'Treasure Finder', acquired: true })
    const override = savedCatalogVersion(localData, BUNDLED_CATALOGS, { sourceRef: SUBJECT, name: 'Personal chest finder' })
    localData = override.localData
    const entry = travelUnlockEntries(localData, BUNDLED_CATALOGS).find(entry => entry.name === 'Personal chest finder')!
    expect(entry.subject).toEqual(override.ref)
    expect(entry.record?.subject).toEqual(SUBJECT)
    expect(entry.state).toEqual({ state: 'known', value: true })
    await render(localData, vi.fn(async () => undefined))
    const link = [...container.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.getAttribute('aria-label') === 'Personal chest finder: location & requirements')!
    expect(link.href).toContain('/reference/personal/')
    expect(container.querySelectorAll('[data-focused="true"]')).toHaveLength(0)
  })
})
