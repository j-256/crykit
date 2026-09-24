import { beforeEach, describe, expect, it } from 'vitest'
import { parseDestination } from './Shell'
import { encodeReferenceEntityKey } from './search'
import {
  commitReferenceRouteState,
  DEFAULT_REFERENCE_ROUTE_STATE,
  formatReferenceRoute,
  parseReferenceRoute,
  readReferenceRouteState,
  REFERENCE_ROUTE_STORAGE_KEY,
  type ReferenceRouteState,
} from './route-state'

describe('reference route state', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '#/inventory')
    window.sessionStorage.clear()
  })

  it('round-trips filters, pagination, and a JSON tuple selection through the hash', () => {
    const selectedKey = encodeReferenceEntityKey({ catalogId: 'pack:alpha', catalogRevisionId: 'r/1', entityId: 'item?2' })
    const state: ReferenceRouteState = {
      query: 'spear & shield',
      kinds: ['item', 'passive'],
      categories: ['Two handed'],
      sources: ['pack:alpha'],
      ppMin: -2,
      ppMax: 8,
      selectedKey,
      resultLimit: 300,
    }
    const hash = formatReferenceRoute(state)
    expect(hash).toMatch(/^#\/reference\?v=1/)
    expect(parseReferenceRoute(hash)).toEqual(state)
  })

  it('preserves opaque facet and entity identities without Unicode folding or trimming', () => {
    const selectedKey = encodeReferenceEntityKey({ catalogId: 'pack：alpha', catalogRevisionId: ' revision ', entityId: 'item：2' })
    const state: ReferenceRouteState = {
      ...DEFAULT_REFERENCE_ROUTE_STATE,
      categories: [' Type：A '],
      sources: [' source：id '],
      selectedKey,
    }
    expect(parseReferenceRoute(formatReferenceRoute(state))).toEqual(state)
  })

  it('restores the last local reference route when navigation returns to a plain reference hash', () => {
    const stored = JSON.stringify({ ...DEFAULT_REFERENCE_ROUTE_STATE, query: 'mantle', kinds: ['passive'] })
    expect(parseReferenceRoute('#/reference', stored)).toMatchObject({ query: 'mantle', kinds: ['passive'] })
    expect(parseReferenceRoute('#/inventory', stored)).toEqual(DEFAULT_REFERENCE_ROUTE_STATE)
  })

  it('bounds malformed route values and rejects invalid selected identities', () => {
    const parsed = parseReferenceRoute('#/reference?v=1&kind=not-a-kind&kind=item&limit=999999&ppMin=NaN&selected=bad')
    expect(parsed.kinds).toEqual(['item'])
    expect(parsed.resultLimit).toBe(2_000)
    expect(parsed.ppMin).toBeUndefined()
    expect(parsed.selectedKey).toBeUndefined()
  })

  it('persists locally and lets browser history restore prior reference states', () => {
    const first = { ...DEFAULT_REFERENCE_ROUTE_STATE, query: 'first' }
    const second = { ...DEFAULT_REFERENCE_ROUTE_STATE, query: 'second' }
    commitReferenceRouteState(first, 'replace')
    commitReferenceRouteState(second, 'push')
    expect(readReferenceRouteState()).toEqual(second)
    expect(JSON.parse(window.sessionStorage.getItem(REFERENCE_ROUTE_STORAGE_KEY) ?? '{}')).toMatchObject({ query: 'second' })
    expect(parseReferenceRoute(formatReferenceRoute(first))).toEqual(first)
  })

  it('keeps the app destination readable when the hash carries reference state', () => {
    window.history.replaceState(null, '', '#/reference?v=1&q=ward')
    expect(parseDestination()).toBe('reference')
  })
})
