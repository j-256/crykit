import { z } from 'zod'
import {
  base64urlSchema,
  digestBytes,
  OpaqueFieldSchemas,
  plainChunkBytes,
  streamOverheadBytes,
} from '../../src/account/protocol'
import { encode } from '../auth/identity'
import type { ServiceContext } from '../context'
import { ApiFailure } from '../http'
import { decode, digest, encoder } from '../sync/storage'

export const recoveryFormat = 1
export const recoveryFragmentBytes = 32 * 1024
// Leave room below D1's per-row limit for fragment/import row framing
// Larger source tuples pause snapshot admission without restricting customer storage
export const recoveryMaximumRowBytes = 1_900_000
export const recoveryPolicySchema = z.strictObject({
  version: z.literal(1),
  maxRows: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  maxEdges: z.number().int().nonnegative(),
  maxWork: z.number().int().positive(),
  maxTemporaryBytes: z.number().int().positive(),
  maxStatements: z.number().int().positive(),
  maxRowBytes: z.number().int().positive().max(recoveryMaximumRowBytes),
})
export const recoverySecretNames = [
  'OPAQUE_SERVER_SETUP',
  'DUMMY_IDENTITY_SECRET',
  'SESSION_SECRET',
  'CURSOR_SECRET',
  'CAPABILITY_SECRET',
  'EMAIL_STATE_SECRET',
  'SERVICE_BACKUP_KEY',
] as const
export async function secretIdentity(context: ServiceContext): Promise<Record<string, string>> {
  const entries = await Promise.all(
    recoverySecretNames.map(async (name) => {
      const value = context.env[name]
      if (
        !value ||
        (name === 'OPAQUE_SERVER_SETUP' && !OpaqueFieldSchemas.setup.safeParse(value).success) ||
        (name !== 'OPAQUE_SERVER_SETUP' && !base64urlSchema(digestBytes).safeParse(value).success)
      )
        throw new ApiFailure('INTEGRITY_FAILED')
      return [name, await digest(encoder.encode(`crykit-service-secret:v1:${name}:${value}`))] as const
    }),
  )
  return Object.fromEntries(entries)
}
async function key(context: ServiceContext) {
  if (!base64urlSchema(digestBytes).safeParse(context.env.SERVICE_BACKUP_KEY).success)
    throw new ApiFailure('INTEGRITY_FAILED')
  return crypto.subtle.importKey('raw', decode(context.env.SERVICE_BACKUP_KEY!), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}
export async function sealRecovery(bytes: Uint8Array, label: string, context: ServiceContext): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`crykit-service-snapshot:v1:${label}`) },
      await key(context),
      bytes,
    ),
  )
  const result = new Uint8Array(nonce.length + cipher.length)
  result.set(nonce)
  result.set(cipher, nonce.length)
  return result
}
export async function openRecovery(bytes: Uint8Array, label: string, context: ServiceContext): Promise<Uint8Array> {
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: bytes.slice(0, 12),
          additionalData: encoder.encode(`crykit-service-snapshot:v1:${label}`),
        },
        await key(context),
        bytes.slice(12),
      ),
    )
  } catch {
    throw new ApiFailure('INTEGRITY_FAILED')
  }
}
export const objectReferenceSchema = z.strictObject({
  key: z.string().regex(/^recovery\/[A-Za-z0-9_-]{22}$/),
  size: z.number().int().nonnegative().max(recoveryMaximumRowBytes),
  digest: base64urlSchema(digestBytes),
})
// Ciphertext follows the accepted sync chunk bound, independently of D1 metadata row limits
export const cipherObjectReferenceSchema = objectReferenceSchema.extend({
  size: z
    .number()
    .int()
    .min(streamOverheadBytes)
    .max(plainChunkBytes + streamOverheadBytes),
})
export type ObjectReference = z.infer<typeof objectReferenceSchema>
export const manifestSchema = z.strictObject({
  version: z.literal(1),
  snapshotId: z.string(),
  sourceGeneration: z.string().min(1).max(64),
  createdAt: z.number().int(),
  rows: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  items: z.number().int().nonnegative(),
  last: objectReferenceSchema.nullable(),
  secrets: z.record(z.string(), base64urlSchema(digestBytes)),
  ledger: z.strictObject({
    version: z.literal(1),
    sequence: z.number().int().nonnegative(),
    digest: base64urlSchema(digestBytes).nullable(),
  }),
})
export type RecoveryManifest = z.infer<typeof manifestSchema>
export function reference(row: { object_key: string; size: number; digest: string }): ObjectReference {
  return { key: row.object_key, size: row.size, digest: row.digest }
}
export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value))
export const encodeBytes = encode
