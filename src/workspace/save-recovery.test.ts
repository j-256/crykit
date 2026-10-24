import { expect, it, vi } from 'vitest'
import { sha256 } from '../interchange/util'
import { recoveryCopyChunks, collectRecoveryCopy, writeRecoveryCopy, RECOVERY_FALLBACK_BYTES } from './save-recovery'

async function fixture() {
  const originalBytes = new Uint8Array([0, 255, 17]), workingBytes = new Uint8Array([71, 18, 255, 0])
  return { filename: 'synthetic.sav', originalBytes, workingBytes, original: { byteLength: originalBytes.length, sha256: await sha256(originalBytes) }, working: { byteLength: workingBytes.length, sha256: await sha256(workingBytes) }, storedPending: { version: 999, future: ['preserve', 17] }, livePending: { version: 1, fields: { currency: 'later invalid' } } }
}
it('streams a self-contained versioned copy of exact saved bytes and distinct inert stored/live input', async () => {
  const input = await fixture(), chunks: Uint8Array[] = []
  for await (const chunk of recoveryCopyChunks(input)) chunks.push(chunk)
  const text = new TextDecoder().decode(await collectRecoveryCopy(input)), records = text.trim().split('\n').map(line => JSON.parse(line))
  expect(records[0]).toMatchObject({ format: 'crykit-save-recovery', version: 1, storedPending: input.storedPending, livePending: input.livePending })
  for (const kind of ['original', 'working']) {
    const restored = Buffer.concat(records.filter(record => record.kind === kind).map(record => Buffer.from(record.base64, 'base64')))
    expect(restored).toEqual(Buffer.from(kind === 'original' ? input.originalBytes : input.workingBytes))
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(text))
  expect(text).not.toMatch(/documentId|revisionId|accountId|receipt|token/)
})
it('rejects wrong lengths or digests before writing any recovery bytes', async () => {
  const input = await fixture(), write = vi.fn()
  for (const original of [{ ...input.original, byteLength: 9 }, { ...input.original, sha256: '0'.repeat(64) }]) {
    const abort = vi.fn(async () => {}), close = vi.fn(async () => {})
    await expect(writeRecoveryCopy({ ...input, original }, { write, abort, close }, () => {})).rejects.toThrow()
    expect(write).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(abort).toHaveBeenCalledTimes(1)
  }
})
it('bounds fallback allocation and aborts a streamed sink if current ownership changes', async () => {
  const input = await fixture(), large = new Uint8Array(RECOVERY_FALLBACK_BYTES)
  await expect(collectRecoveryCopy({ ...input, originalBytes: large })).rejects.toThrow(/stream/i)
  let current = true
  const sink = { write: vi.fn(async () => { current = false }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
  await expect(writeRecoveryCopy(input, sink, () => { if (!current) throw new Error('Profile changed') })).rejects.toThrow('Profile changed')
  expect(sink.abort).toHaveBeenCalledTimes(1); expect(sink.close).not.toHaveBeenCalled()
  expect(input.livePending.fields.currency).toBe('later invalid')
})

it('rejects oversized self-contained metadata before writing a streamed header', async () => {
  const input = await fixture(), sink = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
  await expect(writeRecoveryCopy({ ...input, filename: 'x'.repeat(2 * 1024 * 1024) }, sink, () => {})).rejects.toThrow(/limit/)
  expect(sink.write).not.toHaveBeenCalled(); expect(sink.close).not.toHaveBeenCalled(); expect(sink.abort).toHaveBeenCalledOnce()
})
