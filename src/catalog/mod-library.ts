import { gunzipSync } from 'fflate'
import type { BundledLibraryMod } from '../domain/mod-library'
import { sha256 } from '../interchange/util'

export { BUNDLED_MOD_LIBRARY } from './mod-library-metadata'

export interface PackedModSource { readonly schemaVersion: number; readonly encoding: string; readonly sha256: string; readonly sourceBytes: number; readonly data: string }
const SOURCE_LOADERS = import.meta.glob<PackedModSource>('../assets/mod-sources/*.json', { import: 'default' })

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
