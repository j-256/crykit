import { getSodium } from './sodium'

// Native digest snapshots the supplied view before returning its promise
// Consumers that use those bytes again after awaiting must retain their own immutable copy
// https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/#SubtleCrypto-method-digest
export function digestSha256(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const input = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Uint8Array.from(bytes)
    try { return crypto.subtle.digest('SHA-256', input).then(result => new Uint8Array(result)) }
    finally { if (input.buffer !== bytes.buffer) input.fill(0) }
  }
  // Local guest use can lack a secure context; capture before the lazy runtime import
  const input = Uint8Array.from(bytes)
  return getSodium().then(sodium => sodium.crypto_hash_sha256(input)).finally(() => input.fill(0))
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(await digestSha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}
