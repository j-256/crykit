import { describe, expect, it } from 'vitest'
import type { CatalogRef, EntityRef } from '../domain/types'
import type { AppRoute, PageRoute } from './navigation'
import { formatAppRoute, parentRoute, parseAppRoute } from './navigation'

const catalogRef = { kind: 'catalog' as const, catalogId: 'pack / alpha', catalogRevisionId: 'revision:1', entityId: 'item ? one' } as EntityRef
const personalRef = { kind: 'personal' as const, definitionId: 'personal / one' } as EntityRef

function route(page: PageRoute): AppRoute {
  return { page, overlays: [], query: {} }
}

function expectRoundTrip(value: AppRoute) {
  expect(parseAppRoute(formatAppRoute(value))).toEqual(value)
}

describe('semantic navigation routes', () => {
  it('round-trips every page and action identity', () => {
    const pages = [
      { page: 'inventory', view: 'list' },
      { page: 'inventory', view: 'new' },
      { page: 'inventory', view: 'event-new' },
      { page: 'inventory', view: 'edit', positionId: 'position / one' },
      { page: 'characters', view: 'list' },
      { page: 'characters', view: 'new' },
      { page: 'characters', view: 'character', characterId: 'character / one', tab: 'current' },
      { page: 'characters', view: 'snapshot-new', characterId: 'character / one' },
      { page: 'characters', view: 'snapshot', characterId: 'character / one', snapshotId: 'snapshot / one' },
      { page: 'characters', view: 'snapshot-compare', characterId: 'character / one' },
      { page: 'characters', view: 'snapshot-pair', characterId: 'character / one', leftSnapshotId: 'snapshot / one', rightSnapshotId: 'snapshot / two' },
      { page: 'characters', view: 'skill-screenshots', characterId: 'character / one' },
      { page: 'characters', view: 'class-new', characterId: 'character / one' },
      { page: 'characters', view: 'class-edit', characterId: 'character / one', ref: catalogRef },
      { page: 'characters', view: 'learning-new', characterId: 'character / one', learningKind: 'knowledge' },
      { page: 'characters', view: 'learning-edit', characterId: 'character / one', learningKind: 'magic', ref: personalRef },
      { page: 'builds', view: 'library' },
      { page: 'builds', view: 'build-new' },
      { page: 'builds', view: 'build', buildId: 'build / one' },
      { page: 'builds', view: 'revision-new', buildId: 'build / one' },
      { page: 'builds', view: 'revision', buildId: 'build / one', revisionId: 'revision / one' },
      { page: 'builds', view: 'revision-edit', buildId: 'build / one', revisionId: 'revision / one', baseRevisionId: 'base / one' },
      { page: 'builds', view: 'record-current', buildId: 'build / one', revisionId: 'revision / one' },
      { page: 'builds', view: 'teams' },
      { page: 'builds', view: 'scenario-new' },
      { page: 'builds', view: 'scenario', scenarioId: 'scenario / one' },
      { page: 'builds', view: 'compare' },
      { page: 'builds', view: 'compare-pair', leftRevisionId: 'left / one', rightRevisionId: 'right / two' },
      { page: 'progress', view: 'list' },
      { page: 'progress', view: 'new' },
      { page: 'progress', view: 'edit', recordId: 'record / one' },
      { page: 'reference', view: 'list' },
      { page: 'reference', view: 'detail', ref: catalogRef },
      { page: 'reference', view: 'detail', ref: personalRef },
      { page: 'reference', view: 'promote' },
      { page: 'settings', section: 'data' },
      { page: 'settings', section: 'data', previewId: 'preview / one' },
      { page: 'settings', section: 'game-setup' },
      { page: 'settings', section: 'history' },
      { page: 'settings', section: 'storage' },
      { page: 'settings', section: 'credits' },
    ] as unknown as PageRoute[]
    for (const page of pages) expectRoundTrip(route(page))
  })

  it('round-trips record identities that equal reserved route words', () => {
    const pages = [
      ...['new', 'search', 'pick', 'definitions', 'corrections', 'correct'].flatMap((id) => [
        { page: 'characters', view: 'character', characterId: id, tab: 'current' },
        { page: 'builds', view: 'build', buildId: id },
        { page: 'builds', view: 'scenario', scenarioId: id },
        { page: 'progress', view: 'edit', recordId: id },
      ]),
      { page: 'builds', view: 'revision', buildId: 'build', revisionId: 'new' },
      ...['search', 'pick', 'definitions'].map((id) => ({ page: 'characters', view: 'snapshot-pair', characterId: 'character', leftSnapshotId: id, rightSnapshotId: 'right' })),
      ...['search', 'pick', 'definitions'].map((id) => ({ page: 'builds', view: 'compare-pair', leftRevisionId: id, rightRevisionId: 'right' })),
    ] as unknown as PageRoute[]

    for (const page of pages) {
      const formatted = formatAppRoute(route(page))
      expect(formatted).toContain('%')
      expectRoundTrip(route(page))
    }
  })

  it('parses search overlays after page prefixes without accepting extra path segments', () => {
    expect(parseAppRoute('#/inventory/search?q=sword')).toMatchObject({ page: { page: 'inventory', view: 'list' }, overlays: [{ kind: 'search', query: 'sword' }] })
    expect(parseAppRoute('#/reference/search?q=sword')).toMatchObject({ page: { page: 'reference', view: 'list' }, overlays: [{ kind: 'search', query: 'sword' }] })
    expect(parseAppRoute('#/characters/character-example/current/search')).toMatchObject({ page: { page: 'characters', view: 'character', characterId: 'character-example', tab: 'current' }, overlays: [{ kind: 'search' }] })
    expect(parseAppRoute('#/inventory/unknown/search').page.page).toBe('unresolved')
    expect(parseAppRoute('#/characters/character/history/compare/search?q=staff')).toMatchObject({ page: { page: 'characters', view: 'snapshot-compare' }, overlays: [{ kind: 'search', query: 'staff' }] })
    for (const hash of ['#/characters/c/history/snapshots/%E0%A4%A', '#/characters/c/history/compare/a', '#/characters/c/history/compare/a/b/extra']) expect(parseAppRoute(hash).page.page).toBe('unresolved')
    expect(parentRoute(parseAppRoute('#/characters/c/history/snapshots/s'))?.page).toEqual({ page: 'characters', view: 'character', characterId: 'c', tab: 'history' })
    expect(parentRoute(parseAppRoute('#/characters/c/history/compare/a/b'))?.page).toEqual({ page: 'characters', view: 'character', characterId: 'c', tab: 'history' })
  })

  it('canonicalizes character roots and rejects removed character subpages', () => {
    const root = parseAppRoute('#/characters/character-example')
    expect(root).toMatchObject({ page: { page: 'characters', view: 'character', characterId: 'character-example', tab: 'current' }, legacy: true })
    expect(formatAppRoute(root)).toBe('#/characters/character-example/current')
    for (const section of ['classes', 'knowledge', 'magic']) expect(parseAppRoute(`#/characters/character-example/${section}`).page.page).toBe('unresolved')
  })

  it('round-trips picker and editor descendants with every parent query intact', () => {
    const value: AppRoute = {
      page: { page: 'characters', view: 'snapshot-new', characterId: 'character one' } as unknown as PageRoute,
      overlays: [
        { kind: 'definition-picker', fieldKey: 'slot:accessory / one', query: 'ward', resultLimit: 300 },
        { kind: 'definition-editor', mode: 'new' },
        { kind: 'search', query: 'other' },
      ],
      query: { category: ['Accessory'], source: ['source / one'] },
    }
    expectRoundTrip(value)
    expect(formatAppRoute(value)).toContain('/snapshots/new/pick/slot/')
  })

  it('allows an exact Reference override and rejects picker identities the page cannot render', () => {
    const referenceOverride: AppRoute = {
      page: { page: 'reference', view: 'detail', ref: catalogRef },
      overlays: [{ kind: 'definition-editor', mode: 'override', ref: catalogRef }],
      query: {},
    }
    expectRoundTrip(referenceOverride)
    expect(parseAppRoute('#/inventory/pick/nope').page.page).toBe('unresolved')
    expect(parseAppRoute('#/inventory/new/pick/item-definition').page.page).toBe('inventory')
  })

  it('restores correction review routes and their semantic parents', () => {
    const value: AppRoute = {
      page: { page: 'reference', view: 'detail', ref: catalogRef },
      overlays: [{ kind: 'corrections' }, { kind: 'correction-editor', ref: catalogRef as CatalogRef, field: 'Location / source' }],
      query: { q: ['Artisan Rapier'] },
    }
    expectRoundTrip(value)
    expectRoundTrip(parentRoute(value)!)
    expectRoundTrip(parentRoute(parentRoute(value)!)!)
    expectRoundTrip({ ...value, page: { page: 'settings', section: 'data' } })
    expectRoundTrip({ ...value, overlays: [value.overlays[1]!] })
    for (const hash of ['#/reference/corrections/corrections', '#/reference/correct/personal/example', '#/reference/correct/catalog/a/revisions/b/entities/c/field']) expect(parseAppRoute(hash).page.page).toBe('unresolved')
  })

  it('rejects overlay shapes and disabled picker actions that no view can render', () => {
    const rejected = [
      '#/inventory/events/new/pick/item-reference',
      '#/characters/character/classes/personal/class/edit/pick/class-reference',
      '#/characters/character/knowledge/personal/node/edit/pick/node-reference',
      '#/progress/record/edit/pick/class-reference',
      '#/inventory/search/search',
      '#/inventory/new/pick/item-definition/pick/item-definition',
      '#/inventory/search/definitions/override/personal/definition',
      '#/inventory/definitions/new',
      '#/builds/library/new/pick/primary-class/definitions/new',
      '#/builds/library/build/revisions/new/pick/primary-class/definitions/new',
    ]
    for (const hash of rejected) expect(parseAppRoute(hash).page.page).toBe('unresolved')

    const pickerWithSearchEditor = parseAppRoute('#/inventory/new/pick/item-definition/definitions/new/search/definitions/new')
    expect(pickerWithSearchEditor.page).toEqual({ page: 'inventory', view: 'new' })
    expect(pickerWithSearchEditor.overlays.map((overlay) => overlay.kind)).toEqual(['definition-picker', 'definition-editor', 'search', 'definition-editor'])
    expect(parseAppRoute('#/inventory/events/new/pick/event-item-reference').page).toEqual({ page: 'inventory', view: 'event-new' })
  })

  it('handles empty locations and prototype-shaped query keys without throwing', () => {
    for (const hash of ['', '#', '#/']) {
      expect(parseAppRoute(hash)).toMatchObject({ page: { page: 'builds', view: 'library' }, legacy: true })
    }
    expect(() => parseAppRoute('#/inventory?__proto__=x&constructor=y&prototype=z')).not.toThrow()
    expect(parseAppRoute('#/inventory?__proto__=x&constructor=y&prototype=z').query).toEqual(Object.fromEntries([['__proto__', ['x']], ['constructor', ['y']], ['prototype', ['z']]]))
  })

  it('returns one semantic parent at a time', () => {
    const nested: AppRoute = {
      page: { page: 'builds', view: 'revision-new', buildId: 'build-1' } as unknown as PageRoute,
      overlays: [{ kind: 'definition-picker', fieldKey: 'primary-class', query: '', resultLimit: 100 }, { kind: 'search', query: 'Warrior' }],
      query: {},
    }
    const picker = parentRoute(nested)!
    const editor = parentRoute(picker)!
    expect(picker.overlays).toHaveLength(1)
    expect(editor.page).toEqual({ page: 'builds', view: 'revision-new', buildId: 'build-1' })
    expect(parentRoute(editor)?.page).toEqual({ page: 'builds', view: 'build', buildId: 'build-1' })
    expect(parentRoute(parseAppRoute('#/settings/data'))?.page).toEqual({ page: 'builds', view: 'library' })
    expect(parseAppRoute('#/unknown').page).toMatchObject({ page: 'unresolved', recovery: 'builds' })
    expect(parseAppRoute('#/inventory/unknown').page).toMatchObject({ page: 'unresolved', recovery: 'inventory' })
  })
})
