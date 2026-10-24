import { deflateSync } from 'fflate'
import { expect, it } from 'vitest'
import { encodeBackupPage, decodeBackupPage } from './workspace-backup-compression'
import { WORKSPACE_BACKUP_LIMITS } from './workspace-backup-schema'

it('roundTripsCanonicalCompressedPagesExactly', () => {
  const bytes = new TextEncoder().encode('[["text-value","synthetic repeated text repeated text repeated text"]]')
  const page = encodeBackupPage(bytes)
  expect(decodeBackupPage(page)).toEqual(bytes)
  expect(encodeBackupPage(bytes)).toEqual(page)
  // Persisted codec v1 bytes must survive dependency upgrades, not merely agree with the new encoder
  const persisted = Uint8Array.from('460000008b8e562a49ad28d12d4bcc294d55d2512aaecc2bc9482dc94c56284a2d484d2c494d5100c9e3e329c5c60200'.match(/../g)!, value => Number.parseInt(value, 16))
  expect(page).toEqual(persisted)
  expect(decodeBackupPage(persisted)).toEqual(bytes)
})
it('rejectsTruncationTrailingBytesAndFalseExpandedLengths', () => {
  const page = encodeBackupPage(new TextEncoder().encode('[["value",1]]'))
  for (const length of [0, 3, page.length - 1]) expect(() => decodeBackupPage(page.subarray(0, length))).toThrow()
  const trailing = new Uint8Array(page.length + 1); trailing.set(page)
  expect(() => decodeBackupPage(trailing)).toThrow()
  for (const delta of [-1, 1]) { const changed = page.slice(); new DataView(changed.buffer).setUint32(0, new DataView(page.buffer).getUint32(0, true) + delta, true); expect(() => decodeBackupPage(changed)).toThrow() }
  const corrupt = page.slice(); corrupt[corrupt.length - 1] ^= 255
  expect(() => decodeBackupPage(corrupt)).toThrow()
})
it('rejectsExpansionBombBeforeAcceptingThePage', () => {
  const compressed = deflateSync(new Uint8Array(WORKSPACE_BACKUP_LIMITS.payload + 1))
  const page = new Uint8Array(4 + compressed.length)
  new DataView(page.buffer).setUint32(0, WORKSPACE_BACKUP_LIMITS.payload, true); page.set(compressed, 4)
  expect(() => decodeBackupPage(page)).toThrow(/expanded|length|bound/i)
  new DataView(page.buffer).setUint32(0, WORKSPACE_BACKUP_LIMITS.payload + 1, true)
  expect(() => decodeBackupPage(page)).toThrow(/bound/i)
})
