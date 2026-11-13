import { expect, it } from 'vitest'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { sealImportedCatalog } from '../interchange/source-identity'
import { previewLibrarySource } from './mod-repository'

it('rejects a forged projection even when the original bytes and declared binding are valid', async () => {
  const preview = await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic', Items: [{ ID: 1, Name: 'Original' }] })), 'source.json')
  const original = preview.proposed.catalogs[0]!
  const entity = Object.values(original.entities)[0]!
  const forged = await sealImportedCatalog({ ...original, entities: { ...original.entities, [entity.id]: { ...entity, name: 'Forged' } } })
  const tampered = { ...preview, proposed: { ...preview.proposed, catalogs: [forged], sources: preview.proposed.sources.map(source => ({ ...source, catalogs: [{ id: forged.id, revisionId: forged.revisionId, checksum: forged.checksum }] })) } }
  await expect(previewLibrarySource(tampered)).rejects.toThrow('projection')
  await expect(previewLibrarySource(preview)).resolves.toMatchObject({ catalogId: original.id, catalogRevisionId: original.revisionId })
})
