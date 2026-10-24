import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalPasswordEnvelope, unlockLocalPasswordEnvelope } from './local-unlock'
import { getSodium } from './sodium'

const accountId = Buffer.alloc(16, 1).toString('base64url')
const key = new Uint8Array(32).fill(19)
const password = '  synthetic exact password é  '
afterEach(() => vi.restoreAllMocks())

describe('local password unlock', () => {
  it('persists a restartable Argon2id envelope without password or plaintext keys', async () => {
    const envelope = await createLocalPasswordEnvelope(key, password, accountId)
    expect(envelope.kdf).toMatchObject({ algorithm: 'argon2id', memoryBytes: 64 * 1024 * 1024, iterations: 2, version: 19 })
    const persisted = JSON.stringify(envelope)
    expect(persisted).not.toContain(password)
    expect(persisted).not.toContain(Buffer.from(key).toString('base64url'))
    expect(await unlockLocalPasswordEnvelope(JSON.parse(persisted), password, accountId)).toEqual(key)
    const other = await createLocalPasswordEnvelope(key, password, accountId)
    expect(other.kdf.salt).not.toBe(envelope.kdf.salt)
    expect(other.keyEnvelope.nonce).not.toBe(envelope.keyEnvelope.nonce)
  })

  it.each(['wrong password', password.trim(), password.normalize('NFD')])('rejects altered passwords without normalization: %s', async wrong => {
    const envelope = await createLocalPasswordEnvelope(key, password, accountId)
    await expect(unlockLocalPasswordEnvelope(envelope, wrong, accountId)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
  })

  it('binds the account and rejects unsupported parameters before expensive derivation', async () => {
    const envelope = await createLocalPasswordEnvelope(key, password, accountId)
    await expect(unlockLocalPasswordEnvelope(envelope, password, Buffer.alloc(16, 2).toString('base64url'))).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    const s = await getSodium()
    const derive = vi.spyOn(s, 'crypto_pwhash').mockImplementation(() => { throw new Error('must not derive') })
    for (const kdf of [{ ...envelope.kdf, memoryBytes: 1024 }, { ...envelope.kdf, iterations: 1 }, { ...envelope.kdf, version: 16 }, { ...envelope.kdf, salt: 'bad' }]) {
      await expect(unlockLocalPasswordEnvelope({ ...envelope, kdf }, password, accountId)).rejects.toMatchObject({ code: 'UNSUPPORTED_LOCAL_ENVELOPE' })
    }
    expect(derive).not.toHaveBeenCalled()
  })

  it('reports allocation failures without retrying a weaker profile', async () => {
    const s = await getSodium()
    vi.spyOn(s, 'crypto_pwhash').mockImplementation(() => { throw new Error('synthetic allocation failure') })
    await expect(createLocalPasswordEnvelope(key, password, accountId)).rejects.toMatchObject({ code: 'LOCAL_KDF_FAILED' })
  })
})
