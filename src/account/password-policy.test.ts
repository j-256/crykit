import { describe, expect, it } from 'vitest'
import { validatePassword } from './password-policy'
import { credentialIdForRole, opaqueFieldBytes, OpaqueFieldSchemas } from './protocol'

describe('password and fixed-release transcript boundaries', () => {
  it('preserves spaces and decomposed Unicode without normalizing', () => {
    expect(validatePassword(' e\u0301 synthetic password ')).toEqual({ valid: true })
    expect(validatePassword(' '.repeat(15))).toEqual({ valid: true })
    expect(validatePassword('😀'.repeat(14))).toEqual({ valid: false, reason: 'too-short' })
  })
  it('accepts 1024 UTF-8 bytes and rejects 1025 without truncation', () => {
    expect(validatePassword('é'.repeat(512))).toEqual({ valid: true })
    expect(validatePassword('é'.repeat(512) + 'a')).toEqual({ valid: false, reason: 'too-long' })
    expect(validatePassword('short')).toEqual({ valid: false, reason: 'too-short' })
  })
  it('rejects unpaired surrogates instead of encoding replacement characters', () => {
    for (const value of ['a'.repeat(15) + '\ud800', '\udc00' + 'a'.repeat(15), '\ud800a\udc00' + 'a'.repeat(15)]) expect(validatePassword(value)).toEqual({ valid: false, reason: 'invalid-unicode' })
  })
  it('freezes exact canonical serialized field sizes', () => {
    for (const name of Object.keys(opaqueFieldBytes) as (keyof typeof opaqueFieldBytes)[]) {
      const encoded = Buffer.alloc(opaqueFieldBytes[name]).toString('base64url')
      expect(OpaqueFieldSchemas[name].safeParse(encoded).success).toBe(true)
      expect(OpaqueFieldSchemas[name].safeParse(encoded.slice(1)).success).toBe(false)
      expect(OpaqueFieldSchemas[name].safeParse(encoded + 'A').success).toBe(false)
      expect(OpaqueFieldSchemas[name].safeParse(encoded + '=').success).toBe(false)
      if (opaqueFieldBytes[name] % 3) expect(OpaqueFieldSchemas[name].safeParse(encoded.slice(0, -1) + 'B').success).toBe(false)
    }
  })
})

it('bindsCanonicalStableAccountIdentityToCredentialRole', () => {
  expect(credentialIdForRole('AAAAAAAAAAAAAAAAAAAAAA', 'password')).toBe('crykit/password/AAAAAAAAAAAAAAAAAAAAAA')
  expect(credentialIdForRole('AAAAAAAAAAAAAAAAAAAAAA', 'recovery')).toBe('crykit/recovery/AAAAAAAAAAAAAAAAAAAAAA')
  expect(() => credentialIdForRole('AAAAAAAAAAAAAAAAAAAAAB', 'password')).toThrow()
  expect(() => credentialIdForRole('person@example.org', 'password')).toThrow()
})
