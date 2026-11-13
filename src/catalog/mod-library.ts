import { gunzipSync } from 'fflate'
import type { BundledLibraryMod } from '../domain/mod-library'
import { sha256 } from '../interchange/util'
import { unpackJson, type PackedJson } from './packed-json'
import { immutableCatalogSnapshot } from '../interchange/native'
import { sourcePayloadValid, fulfillSource } from '../domain/source-fulfillment'
import type { CatalogSnapshot } from '../domain/types'
import type { ImportPreview } from '../interchange/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { SOURCE_REVISION_RECEIPTS, type BundledSourceRevisionReceipt } from './source-revisions'

export { BUNDLED_MOD_LIBRARY } from './mod-library-metadata'

export interface PackedModSource { readonly schemaVersion: number; readonly encoding: string; readonly sha256: string; readonly sourceBytes: number; readonly data: string }
const SOURCE_LOADERS = import.meta.glob<PackedModSource>('../assets/mod-sources/*.json', { import: 'default' })
const CATALOG_LOADERS = import.meta.glob<PackedJson>('../assets/mod-catalogs/*.json', { import: 'default' })

export async function bundledModCatalog(mod: BundledLibraryMod): Promise<CatalogSnapshot> {
  const load = CATALOG_LOADERS[`../assets/mod-catalogs/${mod.key}-${mod.revisionId}.json`]
  if (!load) throw new Error('The bundled mod catalog is unavailable.')
  const catalog = unpackJson<CatalogSnapshot>(await load())
  if (catalog.id !== mod.id || catalog.revisionId !== mod.revisionId || catalog.checksum !== mod.payloadChecksum || !sourcePayloadValid(catalog)) throw new Error('The bundled mod catalog is damaged.')
  return immutableCatalogSnapshot(catalog)
}

export function bundleImportPreview(preview: ImportPreview, mod: BundledLibraryMod, receipts: readonly BundledSourceRevisionReceipt[] = SOURCE_REVISION_RECEIPTS): ImportPreview {
  const catalog = fulfillSource({ catalogId: mod.id, catalogRevisionId: mod.revisionId }, preview.proposed.catalogs, receipts)?.catalog
  if (!catalog || catalog.checksum !== mod.payloadChecksum || !sourcePayloadValid(catalog, receipts)) throw new Error('The bundled source does not match this exact mod revision.')
  // Retain original-artifact bindings to the imported payload; the trusted receipt supplies the bundle descriptor
  return { ...preview, proposed: { ...preview.proposed, catalogs: [catalog] } }
}

export async function bundledModPreview(mod: BundledLibraryMod): Promise<ImportPreview> {
  const source = await bundledModEditableSource(mod)
  return bundleImportPreview(await previewCrystalEdit(new TextEncoder().encode(source.text), source.filename), mod)
}

export async function bundledModEditableSource(mod: BundledLibraryMod): Promise<{ readonly filename: string; readonly text: string }> {
  const digest = mod.sourceDigest.replace(/^sha256:/, '')
  const load = SOURCE_LOADERS[`../assets/mod-sources/${digest}.json`]
  if (!load) throw new Error('The bundled mod source is unavailable.')
  return decodeBundledModSource(mod, await load())
}

export async function decodeBundledModSource(mod: BundledLibraryMod, source: PackedModSource): Promise<{ readonly filename: string; readonly text: string }> {
  const digest = mod.sourceDigest.replace(/^sha256:/, '')
  if (source.schemaVersion !== 1 || source.encoding !== 'gzip-base64' || source.sha256 !== digest) throw new Error('The bundled mod source is damaged.')
  const bytes = gunzipSync(Uint8Array.from(atob(source.data), byte => byte.charCodeAt(0)))
  if (bytes.length !== source.sourceBytes || await sha256(bytes) !== digest) throw new Error('The bundled mod source is damaged.')
  return { filename: `${mod.title.replace(/[^A-Za-z0-9._-]+/g, '-') || 'mod'}.json`, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
}
