import { gzipSync } from 'node:zlib'
import { SYNTHETIC_BUNDLED_MOD } from './mod.test-helpers'
import { expect, it } from 'vitest'
import { bundledModSearchCatalogs } from './mod-search'
import { mergeModSearchCatalogs } from '../domain/mod-search'
import { BUNDLED_MOD_LIBRARY, bundledModEditableSource, decodeBundledModSource } from './mod-library'
import { previewImport } from '../interchange/import'
import { sha256 } from '../interchange/util'
import { bundledModDefinitionCount } from '../domain/mod-library'

it('opens every bundled full source with exact bytes and supported planning imports', async () => {
  for (const mod of BUNDLED_MOD_LIBRARY) {
    const source = await bundledModEditableSource(mod)
    const bytes = new TextEncoder().encode(source.text)
    expect(`sha256:${await sha256(bytes)}`).toBe(mod.sourceDigest)
    const root = JSON.parse(source.text.replace(/^\uFEFF/, '')) as { ID: string }
    expect(`crystal-edit:${root.ID}`).toBe(mod.id)
    const preview = await previewImport(bytes, source.filename)
    expect(preview.proposed.catalogs[0]?.id).toBe(mod.id)
    const search = bundledModSearchCatalogs().find(catalog => catalog.id === mod.id)
    if (search?.revisionId === preview.proposed.catalogs[0]!.revisionId) {
      expect(Object.keys(search.entities)).toEqual(Object.keys(preview.proposed.catalogs[0]!.entities))
      for (const entity of Object.values(search.entities)) {
        const full = preview.proposed.catalogs[0]!.entities[entity.id]!
        expect([entity.name, entity.kind, entity.sources]).toEqual([full.name, full.kind, full.sources])
        expect(entity.fields['Crystal Edit model ID']).toMatchObject({ state: 'known', value: full.fields['Crystal Edit model ID']!.state === 'known' ? full.fields['Crystal Edit model ID']!.value : undefined })
      }
      expect(mergeModSearchCatalogs([preview.proposed.catalogs[0]!], [search])).toEqual([preview.proposed.catalogs[0]])
    }
    expect(Object.keys(preview.proposed.catalogs[0]!.entities)).toHaveLength(bundledModDefinitionCount(mod))
    expect(preview.proposed.sources[0]?.bytes.length).toBe(bytes.length)
    expect(await sha256(preview.proposed.sources[0]!.bytes)).toBe(mod.sourceDigest.replace(/^sha256:/, ''))
  }
}, 60_000)

it('decodes original synthetic source bytes and rejects altered size, digest and encoding', async () => {
  const text = '\ufeff' + JSON.stringify({ ID: 'synthetic-library', Title: 'Synthetic Library', EditorVersion: 34, Passives: [{ ID: 9000, Name: 'Synthetic Passive', PP: 2 }] }, null, 2).replaceAll('\n', '\r\n') + '\r\n'
  const bytes = new TextEncoder().encode(text)
  const digest = await sha256(bytes)
  const mod = { ...SYNTHETIC_BUNDLED_MOD, sourceDigest: `sha256:${digest}` }
  const packed = { schemaVersion: 1, encoding: 'gzip-base64', sha256: digest, sourceBytes: bytes.length, data: gzipSync(bytes).toString('base64') }
  expect(await decodeBundledModSource(mod, packed)).toEqual({ filename: 'Synthetic-Library.json', text })
  for (const changed of [{ ...packed, sourceBytes: bytes.length + 1 }, { ...packed, sha256: '0'.repeat(64) }, { ...packed, encoding: 'plain' }, { ...packed, data: gzipSync(Buffer.from('{}')).toString('base64') }]) await expect(decodeBundledModSource(mod, changed)).rejects.toThrow('damaged')
  const imported = await previewImport(bytes, 'synthetic.json')
  expect(imported.proposed.sources[0]!.bytes).toEqual(bytes)
  expect(imported.proposed.catalogs[0]?.id).toBe(mod.id)
})
