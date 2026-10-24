import { KeyEnvelopeSchema, OpaqueIdSchema, keyEnvelopeAlgorithm, keyEnvelopeNonceBytes, wireVersion } from '../protocol'
import { encodeContext } from './context'
import { decodeBytes, encodeBytes, getSodium } from './sodium'
import { accountKeyBytes, assertKey, CryptoError } from './types'
import type { JsonValue, KeyEnvelope } from './types'

// The shared envelope transports account/document keys only, never arbitrary unbounded secrets
export async function wrapSecret(secret: Uint8Array, wrappingKey: Uint8Array, context: readonly JsonValue[]): Promise<KeyEnvelope> {
  assertKey(secret)
  assertKey(wrappingKey)
  const sodium = await getSodium()
  const nonce = sodium.randombytes_buf(keyEnvelopeNonceBytes)
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(secret, encodeContext(context), null, nonce, wrappingKey)
  return { version: wireVersion, algorithm: keyEnvelopeAlgorithm, nonce: encodeBytes(sodium, nonce), ciphertext: encodeBytes(sodium, ciphertext) }
}

export async function unwrapSecret(envelope: KeyEnvelope, wrappingKey: Uint8Array, context: readonly JsonValue[]): Promise<Uint8Array> {
  assertKey(wrappingKey)
  const parsed = KeyEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) throw new CryptoError('INTEGRITY_FAILED')
  const sodium = await getSodium()
  try {
    return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, decodeBytes(sodium, parsed.data.ciphertext), encodeContext(context), decodeBytes(sodium, parsed.data.nonce), wrappingKey)
  } catch { throw new CryptoError('INTEGRITY_FAILED') }
}

// Password role callers supply only the OPAQUE client export key, never its server-visible session key
export async function deriveWrappingKey(secret: Uint8Array, accountId: string, role: 'password' | 'recovery'): Promise<Uint8Array> {
  if (!OpaqueIdSchema.safeParse(accountId).success || !secret.length || (role !== 'password' && role !== 'recovery')) throw new CryptoError('INVALID_CRYPTO_INPUT')
  const secretCopy = new Uint8Array(secret)
  let input: CryptoKey
  // WebCrypto retains its own key; clear only our import copy after the import settles
  try { input = await crypto.subtle.importKey('raw', secretCopy, 'HKDF', false, ['deriveBits']) }
  finally { secretCopy.fill(0) }
  const info = new TextEncoder().encode(role === 'password' ? 'crykit/password-wrap/v1' : 'crykit/recovery-wrap/v1')
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(accountId), info }, input, accountKeyBytes * 8)
  return new Uint8Array(bits)
}
