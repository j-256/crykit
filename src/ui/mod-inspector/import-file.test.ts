import { describe, expect, it, vi } from 'vitest'
import { MAX_IMPORT_BYTES, readModFile } from './import-file'

function bytesFile(bytes: Uint8Array<ArrayBuffer>) {
  return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer }
}

describe('exact UTF-8 mod import', () => {
  it('retains a BOM, CRLF, and large number text', async () => {
    const text = '\uFEFF{\r\n"ID":900719925474099312345\r\n}\r\n'
    expect(await readModFile(bytesFile(new TextEncoder().encode(text)))).toBe(text)
  })
  it('rejects malformed UTF-8 without replacement characters', async () => {
    await expect(readModFile(bytesFile(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])))).rejects.toThrow('not valid UTF-8')
  })
  it('rejects oversized files before reading', async () => {
    const arrayBuffer = vi.fn()
    await expect(readModFile({ size: MAX_IMPORT_BYTES + 1, arrayBuffer })).rejects.toThrow('Split the mod')
    expect(arrayBuffer).not.toHaveBeenCalled()
  })
})
