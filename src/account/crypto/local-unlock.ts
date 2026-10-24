import { z } from 'zod'
import { KeyEnvelopeSchema, OpaqueIdSchema, base64urlSchema } from '../protocol'
import { unwrapSecret, wrapSecret } from './envelopes'
import { encodeBytes, decodeBytes, getSodium } from './sodium'
import { accountKeyBytes, assertKey, CryptoError } from './types'
import type { AccountKey, JsonValue } from './types'

const localEnvelopeVersion = 1
const argonVersion = 19
const localMemoryBytes = 64 * 1024 * 1024
const localIterations = 2
const localSaltBytes = 16
const KdfSchema = z.strictObject({ algorithm: z.literal('argon2id'), version: z.literal(argonVersion), memoryBytes: z.literal(localMemoryBytes), iterations: z.literal(localIterations), salt: base64urlSchema(localSaltBytes) })
export const LocalPasswordEnvelopeSchema = z.strictObject({ version: z.literal(localEnvelopeVersion), kdf: KdfSchema, keyEnvelope: KeyEnvelopeSchema })
export type LocalPasswordEnvelope = z.infer<typeof LocalPasswordEnvelopeSchema>
function localContext(accountId: string, kdf: LocalPasswordEnvelope['kdf']): readonly JsonValue[] {
  return ['crykit/local-password-envelope/v1', accountId, localEnvelopeVersion, kdf.algorithm, kdf.version, kdf.memoryBytes, kdf.iterations, kdf.salt]
}
async function localKey(password: string, accountId: string, kdf: LocalPasswordEnvelope['kdf']): Promise<Uint8Array> {
  if (typeof password !== 'string' || !OpaqueIdSchema.safeParse(accountId).success) throw new CryptoError('INVALID_CRYPTO_INPUT')
  const sodium = await getSodium()
  // Exact UTF-8 preserves whitespace and normalization; libsodium Argon2id fixes parallelism to one lane
  const passwordBytes = new TextEncoder().encode(password)
  try {
    return sodium.crypto_pwhash(accountKeyBytes, passwordBytes, decodeBytes(sodium, kdf.salt), kdf.iterations, kdf.memoryBytes, sodium.crypto_pwhash_ALG_ARGON2ID13)
  } catch { throw new CryptoError('LOCAL_KDF_FAILED') }
  finally { sodium.memzero(passwordBytes) }
}

// Local-only restart data: never send this envelope to the service or replace an OPAQUE envelope with it
export async function createLocalPasswordEnvelope(key: AccountKey, password: string, accountId: string): Promise<LocalPasswordEnvelope> {
  assertKey(key)
  const sodium = await getSodium()
  const kdf = { algorithm: 'argon2id', version: argonVersion, memoryBytes: localMemoryBytes, iterations: localIterations, salt: encodeBytes(sodium, sodium.randombytes_buf(localSaltBytes)) } as const
  const wrappingKey = await localKey(password, accountId, kdf)
  try { return { version: localEnvelopeVersion, kdf, keyEnvelope: await wrapSecret(key, wrappingKey, localContext(accountId, kdf)) } }
  finally { sodium.memzero(wrappingKey) }
}
export async function unlockLocalPasswordEnvelope(envelope: unknown, password: string, accountId: string): Promise<AccountKey> {
  const parsed = LocalPasswordEnvelopeSchema.safeParse(envelope)
  // Reject altered resource parameters before allocating; there is no weak-profile fallback
  if (!parsed.success) throw new CryptoError('UNSUPPORTED_LOCAL_ENVELOPE')
  const sodium = await getSodium()
  const wrappingKey = await localKey(password, accountId, parsed.data.kdf)
  try { return await unwrapSecret(parsed.data.keyEnvelope, wrappingKey, localContext(accountId, parsed.data.kdf)) }
  finally { sodium.memzero(wrappingKey) }
}
