import { zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { checkpointContentDigest } from '../domain/checkpoint-identity'
import { SYNTHETIC_RETAINED_CATALOG } from '../domain/retained-catalog.test-helpers'
import { createTestLocalData } from '../domain/test-helpers'
import type { CatalogSnapshot } from '../domain/types'
import { previewNativeBackup } from './native'

afterEach(() => vi.restoreAllMocks())

function retainedCatalog(suffix: string): CatalogSnapshot {
  const { checksum: _checksum, ...source } = SYNTHETIC_RETAINED_CATALOG
  const content = { ...source, id: `${source.id}-${suffix}` as CatalogSnapshot['id'] }
  return { ...content, checksum: `builtin:sha256:${checkpointContentDigest(content)}` }
}

function archive(catalog: unknown, revision = 0): Uint8Array {
  const localData = { ...createTestLocalData(), changes: [], revision }
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  return zipSync({
    'manifest.json': encode({ format: 'crykit-backup', formatVersion: '3.0.0', dataGeneration: LAUNCH_DATA_GENERATION, exportedAt: '2026-01-02T03:04:05.000Z', payload: 'bundle.json', sources: [] }),
    'bundle.json': encode({ localData, lineage: { rootLocalDataId: localData.id }, catalogs: [catalog], evidence: [], history: [] }),
  })
}

it('rejects failed async source hashing without admitting a reusable success', async () => {
  const catalog = retainedCatalog('hash-failure'), bytes = archive(catalog)
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  let rejectSource = true, sourceAttempts = 0
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    const result = await digest(...args)
    const checksum = `builtin:sha256:${Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('')}`
    // Preview hashes the archive too; fail only the complete source body, after its real digest finishes
    if (checksum === catalog.checksum) {
      sourceAttempts++
      if (rejectSource) throw new Error('Synthetic source digest unavailable')
    }
    return result
  })
  await expect(previewNativeBackup(bytes, 'failed.zip')).rejects.toThrow('Synthetic source digest unavailable')
  rejectSource = false
  const recovered = await previewNativeBackup(bytes, 'recovered.zip')
  const reused = await previewNativeBackup(archive(catalog, 7), 'reused.zip')
  expect(recovered.proposed.catalogs[0]).toEqual(catalog)
  expect(reused.proposed.catalogs[0]).toBe(recovered.proposed.catalogs[0])
  expect(reused.proposed.localData.revision).toBe(7)
  expect(sourceAttempts).toBe(2)
})

it.each(['contents', 'checksum'] as const)('rejects altered retained %s after async source validation', async mode => {
  const catalog = retainedCatalog(`altered-${mode}`)
  const entity = Object.values(catalog.entities)[0]!
  const changed = mode === 'checksum'
    ? { ...catalog, checksum: 'builtin:sha256:' + '0'.repeat(64) }
    : { ...catalog, entities: { ...catalog.entities, [entity.id]: { ...entity, name: 'Altered retained definition' } } }
  await expect(previewNativeBackup(archive(changed), 'altered.zip')).rejects.toThrow('invalid identity, revision, or contents')
})

it.each(['extra-field', 'provenance'] as const)('retains strict catalog admission for %s before source validation', async mode => {
  const catalog = retainedCatalog(`shape-${mode}`)
  const entity = Object.values(catalog.entities)[0]!
  const malformed = mode === 'extra-field'
    ? { ...catalog, unchecked: 'Unknown catalog field' }
    : { ...catalog, entities: { ...catalog.entities, [entity.id]: { ...entity, sources: 'Invalid provenance' } } }
  await expect(previewNativeBackup(archive(malformed), 'malformed.zip')).rejects.toThrow('unsupported shape')
})
