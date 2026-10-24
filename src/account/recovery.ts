import { deriveWrappingKey, wrapSecret } from './crypto/envelopes'
import type { AccountKey, KeyEnvelope } from './crypto/types'

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const recoverySecretBytes = 32
const checksumBytes = 4
const encodedCharacters = 58
function encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, result = ''
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31] }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31]
  return result
}
export function recoveryCredentialSecret(secret: Uint8Array): string {
  if (secret.length !== recoverySecretBytes) throw new Error('INVALID_RECOVERY_CODE')
  return btoa(String.fromCharCode(...secret)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function checksum(secret: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(secret))).slice(0, checksumBytes)
}
export async function createRecoveryCode(key: AccountKey, accountId: string): Promise<{ display: string; credentialSecret: string; envelope: KeyEnvelope }> {
  const secret = crypto.getRandomValues(new Uint8Array(recoverySecretBytes))
  let wrappingKey: Uint8Array | undefined
  const bytes = new Uint8Array(recoverySecretBytes + checksumBytes)
  try {
    bytes.set(secret); bytes.set(await checksum(secret), recoverySecretBytes)
    const display = encode(bytes).match(/.{1,4}/g)!.join('-')
    wrappingKey = await deriveWrappingKey(secret, accountId, 'recovery')
    return { display, credentialSecret: recoveryCredentialSecret(secret), envelope: await wrapSecret(key, wrappingKey, [1, accountId]) }
  } finally { secret.fill(0); bytes.fill(0); wrappingKey?.fill(0) }
}
export async function parseRecoveryCode(display: string): Promise<Uint8Array> {
  // Validate locally before starting OPAQUE; checksum and grouping are never credential material
  if (display.length > 128) throw new Error('INVALID_RECOVERY_CODE')
  const text = display.replace(/[-\s]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
  if (text.length !== encodedCharacters) throw new Error('INVALID_RECOVERY_CODE')
  const bytes = new Uint8Array(recoverySecretBytes + checksumBytes)
  let bits = 0, value = 0, index = 0
  for (const character of text) {
    const digit = alphabet.indexOf(character)
    if (digit < 0) throw new Error('INVALID_RECOVERY_CODE')
    value = (value << 5) | digit; bits += 5
    if (bits >= 8) { bits -= 8; bytes[index++] = (value >>> bits) & 255 }
  }
  if (encode(bytes) !== text) throw new Error('INVALID_RECOVERY_CODE')
  const secret = bytes.slice(0, recoverySecretBytes)
  const expected = await checksum(secret)
  if (!expected.every((byte, i) => byte === bytes[recoverySecretBytes + i])) { secret.fill(0); throw new Error('INVALID_RECOVERY_CODE') }
  return secret
}
