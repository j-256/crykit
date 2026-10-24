// Node-only operational adapter, never imported by the Worker entry or browser bundle
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { z } from 'zod'
import { base64urlSchema, digestBytes, OpaqueFieldSchemas } from '../../src/account/protocol'

const secretSchema = base64urlSchema(digestBytes)
export const ProtectedRecoverySecretsSchema = z.strictObject({
  version: z.literal(1),
  environment: z.enum(['local', 'preview', 'production']),
  secrets: z.strictObject({
    OPAQUE_SERVER_SETUP: OpaqueFieldSchemas.setup,
    DUMMY_IDENTITY_SECRET: secretSchema,
    SESSION_SECRET: secretSchema,
    CURSOR_SECRET: secretSchema,
    CAPABILITY_SECRET: secretSchema,
    EMAIL_STATE_SECRET: secretSchema,
    SERVICE_BACKUP_KEY: secretSchema,
  }),
})
const maximumProtectedSourceBytes = 4096
export async function readProtectedRecoverySecrets(path: string, environment: 'local' | 'preview' | 'production') {
  // The explicitly supplied protected structured file is the source of original secret bytes
  // Refuse symlinks, shared permissions and foreign ownership before reading any contents
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.size > maximumProtectedSourceBytes ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error('RECOVERY_SECRET_SOURCE_UNSAFE')
    const parsed = ProtectedRecoverySecretsSchema.safeParse(JSON.parse(await file.readFile('utf8')))
    if (!parsed.success || parsed.data.environment !== environment) throw new Error('RECOVERY_SECRET_SOURCE_INVALID')
    return parsed.data.secrets
  } catch {
    throw new Error('RECOVERY_SECRET_SOURCE_UNAVAILABLE')
  } finally {
    await file.close()
  }
}
