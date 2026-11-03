import { gunzipSync } from 'fflate'

export interface PackedJson { readonly schemaVersion: number; readonly encoding: string; readonly sha256: string; readonly data: string }

export function unpackJson<Value>(packed: PackedJson): Value {
  if (packed.schemaVersion !== 1 || packed.encoding !== 'gzip-base64' || !/^[a-f0-9]{64}$/.test(packed.sha256)) throw new Error('The bundled catalog asset is damaged')
  const binary = atob(packed.data), bytes = new Uint8Array(binary.length)
  // atob returns byte-valued code units; indexed copying avoids per-byte iterator callbacks
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(gunzipSync(bytes))) as Value
}
