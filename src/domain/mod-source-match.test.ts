import { expect, it } from 'vitest'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { modSourceMatch } from './mod-source-match'

it('matches complete payloads without accepting changed interpretation or forged content', async () => {
  const text = JSON.stringify({ ID: 'Synthetic match', EditorVersion: 34, Items: [{ ID: 9000, Name: 'Synthetic item' }] })
  const source = (await previewCrystalEdit(new TextEncoder().encode(text), 'synthetic.json')).proposed.catalogs[0]!
  const receipt = { catalogId: source.id, catalogRevisionId: source.revisionId, checksum: source.checksum, title: 'Synthetic match' }
  const formatted = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify(JSON.parse(text), null, 2)), 'formatted.json')).proposed.catalogs[0]!
  expect(modSourceMatch(receipt, formatted)).toBe('payload')
  const otherInterpretation = source.revisionId.replace(/-p[1-9][0-9]*$/, '-p999') as typeof source.revisionId
  expect(otherInterpretation).not.toBe(source.revisionId)
  expect(modSourceMatch({ ...receipt, catalogRevisionId: otherInterpretation }, source)).toBeUndefined()
  expect(modSourceMatch(receipt, { ...source, entities: {} })).toBeUndefined()
  expect(modSourceMatch({ ...receipt, checksum: `payload:sha256:${'0'.repeat(64)}` }, source)).toBeUndefined()
})
