import { describe, expect, it } from 'vitest'
import type { CatalogRef, EntityRef } from '../domain/types'
import type { AppRoute, PageRoute } from './navigation'
import { formatAppRoute, parentRoute, parseAppRoute, routeForDestination } from './navigation'
import { MAX_SHARE_URL_LENGTH, SHARE_ROUTE_PREFIX } from '../interchange/share'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { MAX_ID_LENGTH } from '../domain/limits'

const catalogRef = { kind: 'catalog' as const, catalogId: 'pack / alpha', catalogRevisionId: 'revision:1', entityId: 'item ? one' } as EntityRef
const personalRef = { kind: 'personal' as const, definitionId: 'personal / one' } as EntityRef

function route(page: PageRoute): AppRoute {
  return { page, overlays: [], query: {} }
}

function expectRoundTrip(value: AppRoute) {
  expect(parseAppRoute(formatAppRoute(value))).toEqual(value)
}

describe('semantic navigation routes', () => {
  it('uses readable entity segments while retaining exact catalog and revision pins', () => {
    for (const [entityId, path] of [
      ['mod:moonlight-project:ability:565', 'mod/moonlight-project/ability/565'],
      ['base:item:tonic', 'base/item/tonic'],
      ['base:warrior:ability:taunt', 'base/warrior/ability/taunt'],
      ['base:monster:179:mode:Chaos', 'base/monster/179/mode/Chaos'],
    ]) {
      const ref = { kind: 'catalog', catalogId: 'fixture', catalogRevisionId: 'revision-a', entityId } as CatalogRef
      const value = route({ page: 'reference', view: 'detail', ref })
      expect(formatAppRoute(value)).toBe(`#/reference/catalog/fixture/revisions/revision-a/entities/${path}`)
      expectRoundTrip(value)
    }
    for (const entityId of Object.keys(DEFAULT_CATALOG.entities)) {
      expectRoundTrip(route({ page: 'reference', view: 'detail', ref: { kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: entityId as CatalogRef['entityId'] } }))
    }
  })

  it('keeps action words and escaped data distinct from entity path boundaries', () => {
    for (const entityId of ['base:class:edit', 'base:ability:search', 'base:mechanic:stat:field', 'base:passive:0:mode:correct', 'mod:pick:ability:0', 'mod:definitions:ability:search', 'mod:project%3A%2Fname:ability:0', 'mod:project / name:ability:0']) {
      const ref = { kind: 'catalog', catalogId: 'fixture / catalog', catalogRevisionId: 'revision:1', entityId } as CatalogRef
      const detail: AppRoute = { ...route({ page: 'reference', view: 'detail', ref }), overlays: [{ kind: 'search', query: 'cost' }] }
      expectRoundTrip(detail)
      expectRoundTrip({ ...detail, overlays: [{ kind: 'correction-editor', ref, field: 'Location / source' }] })
      expectRoundTrip({ ...detail, overlays: [{ kind: 'definition-editor', mode: 'override', ref }] })
      expectRoundTrip(route({ page: 'characters', view: 'class-edit', characterId: 'character' as never, ref }))
      expectRoundTrip(route({ page: 'characters', view: 'learning-edit', characterId: 'character' as never, learningKind: 'knowledge', ref }))
    }
    const ref = { kind: 'catalog', catalogId: 'fixture', catalogRevisionId: 'revision-a', entityId: 'base:ability:search' } as CatalogRef
    expect(formatAppRoute(route({ page: 'reference', view: 'detail', ref }))).toContain('/base/ability/%73earch')
  })

  it('retains arbitrary imported IDs through an explicit opaque identity segment', () => {
    for (const entityId of ['item ? one', 'foreign:record:1', 'base::partial', 'base', 'constructor:record', 'id / value']) {
      const ref = { ...catalogRef, entityId } as CatalogRef
      const value = route({ page: 'reference', view: 'detail', ref })
      expect(formatAppRoute(value)).toContain(`/entities/id/${encodeURIComponent(entityId)}`)
      expectRoundTrip(value)
    }
  })

  it('rejects retired entity encodings and malformed structured identities', () => {
    const root = '#/reference/catalog/fixture/revisions/revision-a/entities/'
    for (const identity of ['mod%3Amoonlight-project%3Aability%3A565', 'base%3Aitem%3Atonic', 'base/ability', 'mod/project/ability', 'base/ability/%E0%A4%A', 'base/ability/a%3Ab', 'base/ability/%00', 'id/base%3Aitem%3Atonic', 'constructor/record/1']) {
      expect(parseAppRoute(root + identity).page).toMatchObject({ page: 'unresolved', reason: 'malformed-entity-reference' })
    }
    expect(parseAppRoute(`${root}base/ability/${'a'.repeat(MAX_ID_LENGTH + 1)}`).page.page).toBe('unresolved')
    expect(parseAppRoute(`${root}base/ability/${'a'.repeat(MAX_ID_LENGTH)}`).page.page).toBe('unresolved')
  })

  it('canonicalizes the Playthrough settings shortcut without opening a Game Setup editor', () => {
    const playthrough = parseAppRoute('#/settings/game-setup?scope=playthrough')
    expect(playthrough).toEqual({ page: { page: 'settings', section: 'playthrough' }, overlays: [], query: {}, legacy: true })
    expect(formatAppRoute(playthrough)).toBe('#/settings/playthrough')
    expect(parseAppRoute('#/settings/game-setup?gameSetup=synthetic-revision')).toEqual({ page: { page: 'settings', section: 'game-setup' }, overlays: [], query: { gameSetup: ['synthetic-revision'] } })
  })

  it('gives Progress pages explicit paths and canonicalizes the root to the first page', () => {
    const root = parseAppRoute('#/progress')
    expect(root).toMatchObject({ page: { page: 'progress', view: 'list' }, legacy: true })
    expect(formatAppRoute(root)).toBe('#/progress/seals')
    expect(formatAppRoute(routeForDestination('progress'))).toBe('#/progress/seals')
    for (const [segment, view] of [['seals', 'list'], ['unlocks', 'unlocks'], ['summons', 'summons'], ['quintar', 'quintar']]) {
      const hash = `#/progress/${segment}`
      expect(parseAppRoute(hash)).toEqual(route({ page: 'progress', view } as PageRoute))
      expect(formatAppRoute(parseAppRoute(hash))).toBe(hash)
    }
    expect(formatAppRoute(parseAppRoute('#/progress/search?q=crystal'))).toBe('#/progress/seals/search?q=crystal')
    expect(parseAppRoute('#/progress/seals/extra').page.page).toBe('unresolved')
    expectRoundTrip(route({ page: 'progress', view: 'edit', recordId: 'seals' as never }))
    expect(parentRoute(parseAppRoute('#/progress/record/edit'))?.page).toEqual({ page: 'progress', view: 'list' })
  })

  it('allows long shared snapshots and their search overlay while retaining ordinary route bounds', () => {
    const shared = route({ page: 'share', encoded: 'a'.repeat(40_000) })
    expectRoundTrip(shared)
    expect(parseAppRoute('#/share/v1/abc').page).toEqual({ page: 'share', encoded: 'abc' })
    expectRoundTrip({ ...shared, overlays: [{ kind: 'search', query: 'sword' }] })
    expect(parentRoute(shared)?.page).toEqual({ page: 'builds', view: 'library' })
    expect(parseAppRoute(`${SHARE_ROUTE_PREFIX}${'a'.repeat(MAX_SHARE_URL_LENGTH)}`).page.page).toBe('unresolved')
    expect(parseAppRoute(`#/reference?q=${'a'.repeat(20_000)}`).page.page).toBe('unresolved')
    for (const hash of ['#/share/v3/abc', '#/share/v1/', '#/share/v1/a%2Fb', '#/share/v1/abc/extra']) expect(parseAppRoute(hash).page.page).toBe('unresolved')
  })
  it('round-trips every page and action identity', () => {
    const pages = [
      { page: 'mods', view: 'library' },
      { page: 'mods', view: 'editor' },
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
      { page: 'teams', view: 'list' },
      { page: 'teams', view: 'new' },
      { page: 'teams', view: 'team', teamId: 'team / one' },
      { page: 'teams', view: 'adopt', teamId: 'team / one' },
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
      { page: 'progress', view: 'unlocks' },
      { page: 'progress', view: 'quintar' },
      { page: 'progress', view: 'new' },
      { page: 'progress', view: 'edit', recordId: 'record / one' },
      { page: 'reference', view: 'list' },
      { page: 'reference', view: 'detail', ref: catalogRef },
      { page: 'reference', view: 'detail', ref: personalRef },
      { page: 'reference', view: 'promote' },
      { page: 'settings', section: 'data' },
      { page: 'settings', section: 'data', previewId: 'preview / one' },
      { page: 'settings', section: 'playthrough' },
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
    expect(parseAppRoute('#/mods/search?q=RevealStatsAuto')).toMatchObject({ page: { page: 'mods', view: 'library' }, overlays: [{ kind: 'search', query: 'RevealStatsAuto' }] })
    expect(parseAppRoute('#/mods/unrecognized').page).toMatchObject({ page: 'unresolved', recovery: 'mods' })
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
