import { afterEach, expect, it, vi } from 'vitest'
import { createRecoveryCode, parseRecoveryCode } from './recovery'
import { loginWithRecovery } from './auth-client'
import { deriveWrappingKey, unwrapSecret } from './crypto/envelopes'

const accountId = 'AAAAAAAAAAAAAAAAAAAAAA'
afterEach(() => vi.unstubAllGlobals())
it('roundTripsGroupedCrockfordSecretAndRecoveryEnvelope', async () => {
  const key = crypto.getRandomValues(new Uint8Array(32))
  const code = await createRecoveryCode(key, accountId)
  expect(code.display).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){13}-[0-9A-HJKMNP-TV-Z]{2}$/)
  const secret = await parseRecoveryCode(code.display)
  expect(secret).toHaveLength(32)
  expect(code.credentialSecret).toBe(btoa(String.fromCharCode(...secret)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  expect(await unwrapSecret(code.envelope, await deriveWrappingKey(secret, accountId, 'recovery'), [1, accountId])).toEqual(key)
  expect(await parseRecoveryCode(code.display.toLowerCase().replaceAll('-', ' '))).toEqual(secret)
})
it('recoveryChecksumDoesNotSendSecret', async () => {
  const code = await createRecoveryCode(new Uint8Array(32), accountId)
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  const corrupted = (code.display[0] === '0' ? '1' : '0') + code.display.slice(1)
  await expect(parseRecoveryCode(corrupted)).rejects.toThrow('INVALID_RECOVERY_CODE')
  await expect(loginWithRecovery('person@example.org', corrupted, false)).rejects.toThrow('INVALID_RECOVERY_CODE')
  expect(fetch).not.toHaveBeenCalled()
  for (const invalid of ['', code.display + '0', code.display.slice(1), '🚫'.repeat(58)]) await expect(parseRecoveryCode(invalid)).rejects.toThrow('INVALID_RECOVERY_CODE')
})
