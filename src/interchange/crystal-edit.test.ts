import { modModelEntity } from '../domain/mod-layers'
import { IMPORTED_RULES_REVISION } from '../domain/game-rules'
import { describe, expect, it } from 'vitest'
import { CRYSTAL_EDIT_FIELDS, exportedTree, growthRatings } from '../domain/crystal-edit'
import { previewImport } from './import'
import { isCrystalEdit, MOD_LIBRARY_IMPORT_REVISION } from './crystal-edit'
import { NativeCatalogSnapshotSchema } from './native-schema'
import { requirePlaythrough } from '../domain'
import type { CatalogSnapshot } from '../domain/types'

import { syntheticCrystalEdit, syntheticPrerequisiteCrystalEdit } from './crystal-edit.test-helpers'

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('Crystal Edit reference import', () => {
  it.each([34, 4, undefined])('recognizes placement-only format %s projects and preserves their exact source without inventing reference definitions', async editorVersion => {
    const input = { ID: 'synthetic-map-placements', Title: 'Synthetic placements', ...(editorVersion === undefined ? {} : { EditorVersion: editorVersion }), Entities: [{ ID: 900001, EntityType: 5, BiomeID: 1, Coord: { X: -12, Y: 99, Z: 4 }, TreasureData: { LootType: 1, LootValue: 18 }, FutureField: { retained: true } }] }
    const bytes = new TextEncoder().encode(`\r\n${JSON.stringify(input, null, 2)}\r\n`)
    const preview = await previewImport(bytes, 'placements.json')
    expect(preview.detectedFormat).toBe('crystal-edit-json-1')
    expect(preview.counts).toEqual({ reference: 0, personal: 0, mixed: 0, ignored: 1 })
    expect(preview.proposed.catalogs[0]!.entities).toEqual({})
    expect(NativeCatalogSnapshotSchema.safeParse(preview.proposed.catalogs[0]).success).toBe(true)
    expect(preview.proposed.sources[0]!.bytes).toEqual(bytes)
    expect(JSON.parse(new TextDecoder().decode(preview.proposed.sources[0]!.bytes))).toEqual(input)
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'archived-models', message: expect.stringContaining('Entities: 1') })]))
    expect(isCrystalEdit({ ...input, Entities: {} })).toBe(false)
    expect(isCrystalEdit({ ID: input.ID, EditorVersion: 'unknown', Entities: input.Entities })).toBe(false)
  })

  it('preserves every simultaneous prerequisite in columns and native snapshot round-trips', async () => {
    const preview = await previewImport(encode(syntheticPrerequisiteCrystalEdit()), 'prerequisites.json')
    const catalog: CatalogSnapshot = JSON.parse(JSON.stringify(preview.proposed.catalogs[0]))
    expect(NativeCatalogSnapshotSchema.safeParse(catalog).success).toBe(true)
    const nodes = exportedTree(modModelEntity(catalog, 'crystal-edit:Jobs:40')!)
    expect(nodes.find(node => node.dataId === 11)?.prerequisites).toEqual([{ row: 0, column: 0 }, { row: 0, column: 1 }])
    expect(nodes.find(node => node.dataId === 10)?.prerequisites).toEqual([{ row: 0, column: 0 }, { row: 0, column: 1 }, { row: 0, column: 2 }])
    expect(preview.warnings.some(warning => warning.code === 'external-model-references')).toBe(false)
  })

  it('detects content, keeps namespaces separate, decodes columns, and preserves unresolved IDs', async () => {
    const input = syntheticCrystalEdit()
    const preview = await previewImport(encode(input), 'anything.txt')
    expect(preview.detectedFormat).toBe('crystal-edit-json-1')
    expect(preview.counts).toMatchObject({ reference: 2, personal: 0, mixed: 0 })
    const catalog = preview.proposed.catalogs[0]!
    expect(Object.keys(catalog.entities).every(id => id.startsWith(`mod:${encodeURIComponent(input.ID)}:`))).toBe(true)
    expect(catalog.revisionId).toBe(`sha256:${preview.sourceDigest}:${IMPORTED_RULES_REVISION}:${MOD_LIBRARY_IMPORT_REVISION}`)
    expect(NativeCatalogSnapshotSchema.safeParse(catalog).success).toBe(true)
    const job = modModelEntity(catalog, 'crystal-edit:Jobs:40')!
    expect(growthRatings(job)).toEqual({ HP: 70, MP: 20 })
    expect(job.fields[CRYSTAL_EDIT_FIELDS.equipment]).toMatchObject({ value: ['Sword', 'Shield', 'Accessory', 'Unrecognized equipment type 99'] })
    expect(exportedTree(job).find(node => node.row === 1 && node.column === 1)).toEqual({ row: 1, column: 1, nodeType: 3, dataId: 2, prerequisites: [{ row: 0, column: 0 }] })
    expect(job.fields['Available as a starting class']).toMatchObject({ state: 'unknown' })
    expect(catalog.legacy).toMatchObject({ unresolvedReferences: ['Abilities #9', 'Passives #2'] })
    expect(modModelEntity(catalog, 'crystal-edit:Abilities:8')?.rawDescription).toBe(input.Abilities[0]!.Description)
    expect(Array.from(preview.proposed.sources[0]!.bytes)).toEqual(Array.from(encode(input)))
    expect(requirePlaythrough(preview.proposed.localData).characters).toEqual({})
    expect(requirePlaythrough(preview.proposed.localData).inventory).toEqual({})
  })

  it('retains zero ratings, missing fields, future node types, and empty explicit membership', async () => {
    const preview = await previewImport(encode({ ID: 'future', EditorVersion: 99, Jobs: [{ ID: 0, Name: 'Future', HPRating: 0, AbilityIDs: [], LearnTree: [[{ NodeType: 8, DataID: 0, PrereqLeft: false, PrereqMiddle: false, PrereqRight: false }]] }] }), 'future.json')
    expect(growthRatings(modModelEntity(preview.proposed.catalogs[0]!, 'crystal-edit:Jobs:0')!)).toEqual({ HP: 0 })
    expect(preview.warnings.some(warning => warning.code === 'unknown-tree-node')).toBe(true)
    expect(modModelEntity(preview.proposed.catalogs[0]!, 'crystal-edit:Jobs:0')!.fields['Class change']).toMatchObject({ value: 'Edits vanilla class ID 0' })
  })

  it('keeps complete vanilla edits distinct from same-name copies and replaces lists within a new snapshot', async () => {
    const original = { ...syntheticCrystalEdit().Jobs[0]!, ID: 4, Name: 'Synthetic Healer', SpiRating: 100, EquipmentTypes: [8, 10, 14, 17, 18], AbilityIDs: [7, 62], PassiveIDs: [16] }
    const copy = { ...original, ID: 27 }
    const first = await previewImport(encode({ ID: 'synthetic-edits', EditorVersion: 34, Jobs: [original, copy] }), 'first.json')
    const edited = { ...original, SpiRating: 10, EquipmentTypes: [8, 10, 14, 16, 17, 18], AbilityIDs: [7], PassiveIDs: [16, 64], LearnTree: [[{ NodeType: 0, DataID: 0, PrereqLeft: true, PrereqMiddle: true, PrereqRight: false }]] }
    const second = await previewImport(encode({ ID: 'synthetic-edits', EditorVersion: 34, Jobs: [edited, copy] }), 'second.json')
    const a = first.proposed.catalogs[0]!
    const b = second.proposed.catalogs[0]!
    expect(b.id).toBe(a.id)
    expect(b.revisionId).not.toBe(a.revisionId)
    const vanillaEdit = modModelEntity(b, 'crystal-edit:Jobs:4')!
    expect(vanillaEdit.fields['Class change']).toMatchObject({ value: 'Edits vanilla class ID 4' })
    expect(modModelEntity(b, 'crystal-edit:Jobs:27')!.fields['Class change']).toMatchObject({ value: 'Adds a custom class' })
    expect(growthRatings(vanillaEdit)).toMatchObject({ HP: 70, MP: 20, SPI: 10 })
    expect(vanillaEdit.fields[CRYSTAL_EDIT_FIELDS.command]).toMatchObject({ value: 'Synthetic Research' })
    expect(vanillaEdit.fields[CRYSTAL_EDIT_FIELDS.equipment]).toMatchObject({ value: ['Staff', 'Book', 'Light Head', 'Medium Body', 'Light Body', 'Accessory'] })
    expect(vanillaEdit.fields[CRYSTAL_EDIT_FIELDS.abilities]).toMatchObject({ value: [7] })
    expect(vanillaEdit.fields[CRYSTAL_EDIT_FIELDS.passives]).toMatchObject({ value: [16, 64] })
    expect(exportedTree(vanillaEdit)).toMatchObject([{ nodeType: 0, dataId: 0 }])
    expect(modModelEntity(a, 'crystal-edit:Jobs:4')!.fields[CRYSTAL_EDIT_FIELDS.abilities]).toMatchObject({ value: [7, 62] })
    expect(growthRatings(modModelEntity(b, 'crystal-edit:Jobs:27')!).SPI).toBe(100)
  })

  it('reports model families that remain in the source archive only', async () => {
    const preview = await previewImport(encode({ ...syntheticCrystalEdit(), Animations: [{ ID: 0, Name: 'Synthetic animation' }] }), 'models.json')
    expect(preview.counts.ignored).toBe(1)
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'archived-models', message: expect.stringContaining('Animations: 1') })]))
  })

  it.each([
    { ID: '\u3042'.repeat(512), EditorVersion: 34, Jobs: [{ ID: 0, Name: 'Oversized encoded identity' }] },
    { ID: 'invalid\u0000project', EditorVersion: 34, Jobs: [{ ID: 0, Name: 'Invalid identity' }] },
    { ID: 'bad', EditorVersion: 34, Jobs: [{ ID: 0, Name: 'Broken', HPRating: -1 }] },
    { ID: 'bad', EditorVersion: 34, Jobs: [{ ID: 0, Name: 'Broken', AbilityIDs: [1.5] }] },
    { ID: 'bad', EditorVersion: 34, Jobs: [{ ID: 0, Name: 'Broken', LearnTree: [[{ NodeType: 2 }]] }] },
    { ID: 'bad', EditorVersion: 34, Jobs: [{ ID: 0, Name: 'First' }, { ID: 0, Name: 'Second' }] },
    { ID: 'bad', EditorVersion: 34, Jobs: [], Abilities: {} },
  ])('rejects malformed models without a partial import', async input => {
    await expect(previewImport(encode(input), 'bad.json')).rejects.toMatchObject({ code: 'schema-mismatch' })
  })
})
