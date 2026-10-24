import { afterEach, expect, it, vi } from 'vitest'
import { STARTER_CATALOG } from '../catalog/starter'
import { addGameSetupRevision, createBlankLocalData } from '../domain/local-data'
import { previewImport } from '../interchange/import'
import { immutableCatalogSnapshot, validateNativeLocalDataGraph } from '../interchange/native'
import { NativeCatalogSnapshotSchema } from '../interchange/native-schema'
import { prepareModCatalogs } from './local-data'

afterEach(() => vi.restoreAllMocks())

it('prepares an exact new effective catalog once for the UI and captured repository without parsing inherited records again', async () => {
  const imported = await previewImport(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-prepared', EditorVersion: 34, Passives: [{ ID: 9000, Name: 'Synthetic prepared passive', PP: 2 }] })), 'synthetic.json')
  const baseline = immutableCatalogSnapshot(STARTER_CATALOG), source = immutableCatalogSnapshot(imported.proposed.catalogs[0]!)
  const catalogs = Object.freeze([baseline, source])
  const data = addGameSetupRevision(createBlankLocalData(), { label: 'Synthetic prepared context', modComposition: { baseline: { catalogId: baseline.id, catalogRevisionId: baseline.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] } })
  const parse = vi.spyOn(NativeCatalogSnapshotSchema, 'safeParse')
  const first = (await prepareModCatalogs(data, catalogs)).at(-1)!
  const again = (await prepareModCatalogs(structuredClone(data), catalogs)).at(-1)!
  expect(again).toBe(first)
  expect(first.entities[Object.keys(baseline.entities)[0]!]).toBe(baseline.entities[Object.keys(baseline.entities)[0]!])
  expect(Object.values(first.entities).find(value => value.name === 'Synthetic prepared passive')).toBeDefined()
  expect(parse.mock.calls.filter(([value]) => value === first)).toEqual([])
  expect(NativeCatalogSnapshotSchema.safeParse(first).success).toBe(true)
  expect(() => validateNativeLocalDataGraph(data, [...catalogs, first])).not.toThrow()
  const alteredBaseline = structuredClone(baseline)
  Object.assign(alteredBaseline.entities[Object.keys(baseline.entities)[0]!]!, { name: 'Changed baseline under equal identity' })
  expect(() => validateNativeLocalDataGraph(data, [immutableCatalogSnapshot(alteredBaseline), source, first])).toThrow('effective mod catalog does not match')
  const alteredView = structuredClone(first)
  Object.assign(alteredView.entities[Object.keys(baseline.entities)[0]!]!, { name: 'Unchecked immutable effective record' })
  expect(() => validateNativeLocalDataGraph(data, [...catalogs, immutableCatalogSnapshot(alteredView)])).toThrow('effective mod catalog does not match')

  const changed = structuredClone(data)
  const setup = changed.gameSetups[changed.planningGameSetupRevisionId!]!
  Object.assign(setup, { label: 'Changed complete context' })
  const different = (await prepareModCatalogs(changed, catalogs)).at(-1)!
  expect(different).not.toBe(first)
  expect(different.revisionId).toBe(first.revisionId)
})
