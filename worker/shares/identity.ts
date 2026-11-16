import { SHARE_ID_ALPHABET, SHARE_ID_LENGTH } from '../../src/account/share-identity'

export const MAX_SHARE_ID_ATTEMPTS = 8
export function randomShareId(): string {
  // Each of the 64 symbols has exactly four preimages in a random byte: no modulo bias or padding bits
  return Array.from(crypto.getRandomValues(new Uint8Array(SHARE_ID_LENGTH)), byte => SHARE_ID_ALPHABET[byte & 63]).join('')
}
