import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntityRef } from '../domain/types'
import { parseDestination } from './Shell'
import { formatAppRoute, parseAppRoute } from './navigation'
import { encodeReferenceEntityKey } from './search'
import {
  commitInventoryRouteState,
  commitReferenceRouteState,
  DEFAULT_INVENTORY_ROUTE_STATE,
  DEFAULT_REFERENCE_ROUTE_STATE,
  formatReferenceRoute,
  parseReferenceRoute,
  parseInventoryRoute,
  readReferenceRouteState,
  REFERENCE_ROUTE_STORAGE_KEY,
  type ReferenceRouteState,
} from './route-state'

describe('reference route state', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '#/inventory')
    window.sessionStorage.clear()
  })

  it('round-trips filters, pagination, and selection through a semantic detail path', () => {
    const selectedKey = encodeReferenceEntityKey({ catalogId: 'pack:alpha', catalogRevisionId: 'r/1', entityId: 'item?2' })
    const state: ReferenceRouteState = {
      query: 'spear & shield',
      weapon: 'Dagger',
      includeUncertainSkills: true,
      kinds: ['item', 'passive'],
      categories: ['Two handed'],
      sources: ['pack:alpha'],
      audiences: ['technical', 'about'],
      classes: ['Scribe', 'Mage'],
      elements: ['Wind'],
      slots: ['mainHand', 'offHand'],
      mods: ['Test pack'],
      ppMin: -2,
      ppMax: 8,
      selectedKey,
      resultLimit: 300,
    }
    const hash = formatReferenceRoute(state)
    expect(hash).toMatch(/^#\/reference\/catalog\/pack%3Aalpha\/revisions\/r%2F1\/entities\/id\/item%3F2\/definition\?v=1/)
    expect(hash).not.toContain('selected=')
    expect(parseReferenceRoute(hash)).toEqual(state)
  })

  it('preserves opaque facet and entity identities without Unicode folding or trimming', () => {
    const selectedKey = encodeReferenceEntityKey({ catalogId: 'pack：alpha', catalogRevisionId: ' revision ', entityId: 'item：2' })
    const state: ReferenceRouteState = {
      ...DEFAULT_REFERENCE_ROUTE_STATE,
      categories: [' Type：A '],
      sources: [' source：id '],
      classes: [' Class：A '],
      slots: [' slot:id '],
      elements: [' element:value '],
      mods: [' Mod & Pack '],
      selectedKey,
    }
    expect(parseReferenceRoute(formatReferenceRoute(state))).toEqual(state)
  })

  it('restores the last local reference route when navigation returns to a plain reference hash', () => {
    const stored = JSON.stringify({ ...DEFAULT_REFERENCE_ROUTE_STATE, query: 'mantle', kinds: ['passive'] })
    expect(parseReferenceRoute('#/reference', stored)).toMatchObject({ query: 'mantle', kinds: ['passive'] })
    expect(parseReferenceRoute('#/inventory', stored)).toEqual(DEFAULT_REFERENCE_ROUTE_STATE)
  })

  it('does not navigate from retired JSON selection queries', () => {
    const selected = encodeReferenceEntityKey({ catalogId: 'fixture', catalogRevisionId: 'revision-a', entityId: 'base:item:tonic' })
    const hash = `#/reference?selected=${encodeURIComponent(selected)}`
    expect(parseAppRoute(hash).page).toEqual({ page: 'reference', view: 'list' })
    expect(parseReferenceRoute(hash).selectedKey).toBeUndefined()
  })

  it('bounds malformed route values and rejects invalid selected identities', () => {
    const parsed = parseReferenceRoute('#/reference?v=1&kind=not-a-kind&kind=item&audience=unknown&audience=tooling&limit=999999&ppMin=NaN&selected=bad')
    expect(parsed.kinds).toEqual(['item'])
    expect(parsed.audiences).toEqual(['tooling'])
    expect(parseReferenceRoute('#/reference?weapon=unknown').weapon).toBeUndefined()
    expect(parseReferenceRoute('#/reference?weapon=daggers').weapon).toBe('Dagger')
    expect(parsed.resultLimit).toBe(2_000)
    expect(parsed.ppMin).toBeUndefined()
    expect(parsed.selectedKey).toBeUndefined()
    expect(parseReferenceRoute('#/reference?class=&class=Scribe&class=Scribe&slot=offHand&element=Wind&mod=Pack')).toMatchObject({ classes: ['Scribe'], slots: ['offHand'], elements: ['Wind'], mods: ['Pack'] })
  })

  it('persists locally and lets browser history restore prior reference states', () => {
    const first = { ...DEFAULT_REFERENCE_ROUTE_STATE, query: 'first', weapon: 'Dagger' as const }
    const second = { ...DEFAULT_REFERENCE_ROUTE_STATE, query: 'second', weapon: 'Bow' as const }
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

  it('preserves the semantic detail and overlay while notifying the controller once', () => {
    const ref = { kind: 'catalog' as const, catalogId: 'pack', catalogRevisionId: 'r1', entityId: 'item' } as EntityRef
    window.history.replaceState({ retained: true }, '', formatAppRoute({
      page: { page: 'reference', view: 'detail', ref },
      overlays: [{ kind: 'search', query: 'planner' }],
      query: { kind: ['item'] },
    }))
    const notified = vi.fn()
    window.addEventListener('crykit:navigation', notified)
    commitReferenceRouteState({ ...DEFAULT_REFERENCE_ROUTE_STATE, query: 'sword', categories: ['Weapon'] }, 'replace')
    window.removeEventListener('crykit:navigation', notified)

    const route = parseAppRoute(window.location.hash)
    expect(route.page).toEqual({ page: 'reference', view: 'detail', ref })
    expect(route.overlays).toEqual([{ kind: 'search', query: 'planner' }])
    expect(parseReferenceRoute(window.location.hash)).toMatchObject({ query: 'sword', categories: ['Weapon'] })
    expect(window.history.state).toMatchObject({ retained: true })
    expect(notified).toHaveBeenCalledTimes(1)
  })

  it('updates inventory filters without replacing its edit and picker route', () => {
    window.history.replaceState(null, '', formatAppRoute({
      page: { page: 'inventory', view: 'edit', positionId: 'position-1' as never },
      overlays: [{ kind: 'definition-picker', fieldKey: 'item-definition', query: 'blade', resultLimit: 100 }],
      query: {},
    }))
    commitInventoryRouteState({ ...DEFAULT_INVENTORY_ROUTE_STATE, filter: 'Owned', sources: ['starter'] })

    const route = parseAppRoute(window.location.hash)
    expect(route.page).toEqual({ page: 'inventory', view: 'edit', positionId: 'position-1' })
    expect(route.overlays).toEqual([{ kind: 'definition-picker', fieldKey: 'item-definition', query: 'blade', resultLimit: 100 }])
    expect(parseInventoryRoute(window.location.hash)).toMatchObject({ filter: 'Owned', sources: ['starter'] })
  })
})
