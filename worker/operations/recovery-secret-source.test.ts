import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readProtectedRecoverySecrets, ProtectedRecoverySecretsSchema } from './recovery-secret-source'

const syntheticSecrets = () => ({
  OPAQUE_SERVER_SETUP: randomBytes(128).toString('base64url'),
  DUMMY_IDENTITY_SECRET: randomBytes(32).toString('base64url'),
  SESSION_SECRET: randomBytes(32).toString('base64url'),
  CURSOR_SECRET: randomBytes(32).toString('base64url'),
  CAPABILITY_SECRET: randomBytes(32).toString('base64url'),
  EMAIL_STATE_SECRET: randomBytes(32).toString('base64url'),
  SERVICE_BACKUP_KEY: randomBytes(32).toString('base64url'),
})

it('accepts explicit qualification originals without reinterpreting existing environments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-qualification-originals-'))
  const path = join(directory, 'synthetic-service-secrets.json')
  try {
    const secrets = syntheticSecrets()
    await writeFile(path, JSON.stringify({ version: 1, environment: 'qualification', secrets }), { mode: 0o600 })
    expect(ProtectedRecoverySecretsSchema.safeParse({ version: 1, environment: 'qualification', secrets }).success).toBe(true)
    // The literal environment must be supported by the reader's public TypeScript contract too
    expect(await readProtectedRecoverySecrets(path, 'qualification')).toEqual(secrets)
    for (const environment of ['local', 'preview', 'production'] as const) {
      await expect(readProtectedRecoverySecrets(path, environment)).rejects.toThrow('RECOVERY_SECRET_SOURCE_UNAVAILABLE')
      await writeFile(path, JSON.stringify({ version: 1, environment, secrets }), { mode: 0o600 })
      expect(await readProtectedRecoverySecrets(path, environment)).toEqual(secrets)
      await expect(readProtectedRecoverySecrets(path, 'qualification')).rejects.toThrow('RECOVERY_SECRET_SOURCE_UNAVAILABLE')
      await writeFile(path, JSON.stringify({ version: 1, environment: 'qualification', secrets }), { mode: 0o600 })
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps qualification originals behind no-follow, restrictive mode and strict schema checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-qualification-originals-'))
  const path = join(directory, 'synthetic-service-secrets.json')
  try {
    const data = { version: 1, environment: 'qualification', secrets: syntheticSecrets() }
    await writeFile(path, JSON.stringify(data), { mode: 0o600 })
    await chmod(path, 0o644)
    await expect(readProtectedRecoverySecrets(path, 'qualification')).rejects.toThrow('RECOVERY_SECRET_SOURCE_UNAVAILABLE')
    await chmod(path, 0o600)
    await symlink(path, join(directory, 'alias.json'))
    await expect(readProtectedRecoverySecrets(join(directory, 'alias.json'), 'qualification')).rejects.toThrow()
    await writeFile(path, JSON.stringify({ ...data, extra: true }))
    await expect(readProtectedRecoverySecrets(path, 'qualification')).rejects.toThrow('RECOVERY_SECRET_SOURCE_UNAVAILABLE')
    await writeFile(path, '{synthetic malformed input')
    await expect(readProtectedRecoverySecrets(path, 'qualification')).rejects.toThrow('RECOVERY_SECRET_SOURCE_UNAVAILABLE')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
