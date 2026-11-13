import { expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { buildBehavior } from './build-behavior'
import { selectBuildModRevision } from './build-mods'
import { composeModCatalog, composeModLayers, modCatalogRevision, modModelEntity } from './mod-layers'
import { definitionOrigins } from './definition-origins'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from './test-helpers'
import { createEntityRouteNameResolver } from '../ui/entity-route-names'
import { formatAppRoute } from '../ui/navigation'
import type { CatalogSnapshot } from './types'

const imported = async (id: string, nativeId: number, localized = false) => (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: id, Title: id, EditorVersion: 34, IsLocalization: localized, Equipment: [{ ID: nativeId, Name: id, EquipmentType: 0, StatMods: [] }] })), 'synthetic.json')).proposed.catalogs[0]!
function context(sources: readonly CatalogSnapshot[]) {
  const original = createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]!
  const catalogs = [DEFAULT_CATALOG, ...sources]
  const behavior = sources.reduce((value, source) => selectBuildModRevision(value, source, catalogs), buildBehavior(original))
  const setup = { ...original, ...behavior, catalogLock: { [DEFAULT_CATALOG.id]: modCatalogRevision(original.id) } }
  return { result: composeModLayers(behavior.modComposition!, catalogs), effective: composeModCatalog(setup, catalogs)!, catalogs }
}

it('keeps a native replacement logical key while linking its exact imported definition', async () => {
  const source = await imported('Synthetic replacement', 3)
  const { result, effective, catalogs } = context([source])
  const entity = result.entities['base:equipment:3']!
  const original = modModelEntity(source, 'crystal-edit:Equipment:3')!
  const ref = { kind: 'catalog' as const, catalogId: source.id, catalogRevisionId: source.revisionId, entityId: original.id }
  expect(entity.id).toBe('base:equipment:3')
  expect(definitionOrigins(effective, entity)).toEqual({ mechanical: ref, text: ref })
  const route = formatAppRoute({ page: { page: 'reference', view: 'detail', ref: { kind: 'catalog', catalogId: effective.id, catalogRevisionId: effective.revisionId, entityId: entity.id } }, overlays: [], query: {} }, createEntityRouteNameResolver([...catalogs, effective]))
  expect(route).toContain(`/imported/${source.id.split('/').at(-1)}/${source.revisionId}/equipment/3/`)
})

it('retains original contributor IDs through collisions and localization', async () => {
  const first = await imported('First source', 9000)
  const second = await imported('Second source', 9000)
  const collision = context([first, second])
  for (const source of [first, second]) {
    const original = modModelEntity(source, 'crystal-edit:Equipment:9000')!
    expect(definitionOrigins(collision.effective, collision.result.entities[original.id]!)?.mechanical).toEqual({ kind: 'catalog', catalogId: source.id, catalogRevisionId: source.revisionId, entityId: original.id })
  }
  const locale = await imported('Localized label', 9000, true)
  const localized = context([first, locale])
  const mechanical = modModelEntity(first, 'crystal-edit:Equipment:9000')!
  const text = modModelEntity(locale, 'crystal-edit:Equipment:9000')!
  const effective = localized.result.entities[mechanical.id]!
  expect(effective.name).toBe('Localized label')
  expect(definitionOrigins(localized.effective, effective)).toEqual({ mechanical: { kind: 'catalog', catalogId: first.id, catalogRevisionId: first.revisionId, entityId: mechanical.id }, text: { kind: 'catalog', catalogId: locale.id, catalogRevisionId: locale.revisionId, entityId: text.id } })
  expect(text.fields['Crystal Edit source record']).toEqual(modModelEntity(locale, 'crystal-edit:Equipment:9000')!.fields['Crystal Edit source record'])
})

it('records vanilla mechanics separately when localization changes only text', async () => {
  const locale = await imported('Native translated label', 3, true)
  const { result, effective } = context([locale])
  expect(definitionOrigins(effective, result.entities['base:equipment:3']!)?.mechanical).toEqual({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: 'base:equipment:3' })
})
