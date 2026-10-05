import { gunzipSync } from 'fflate'

export interface PackedJson { readonly schemaVersion: number; readonly encoding: string; readonly sha256: string; readonly data: string }

export function unpackJson<Value>(packed: PackedJson): Value {
  if (packed.schemaVersion !== 1 || packed.encoding !== 'gzip-base64' || !/^[a-f0-9]{64}$/.test(packed.sha256)) throw new Error('The bundled catalog asset is damaged')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(gunzipSync(Uint8Array.from(atob(packed.data), byte => byte.charCodeAt(0))))) as Value
}
