import { expect, it, vi } from 'vitest'
import { writeDownloadStream, collectDownloadBlob, WORKSPACE_DOWNLOAD_FALLBACK_BYTES } from './download-stream'

async function* chunks() { yield new Uint8Array([1, 2]); yield new Uint8Array([3]) }
it('streamsWithBackpressureAndAbortsFailedWrites', async () => {
  const writes: number[][] = []
  const sink = { write: vi.fn(async (bytes: Uint8Array) => { writes.push([...bytes]) }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
  await writeDownloadStream(chunks(), sink, () => {})
  expect(writes).toEqual([[1, 2], [3]])
  expect(sink.close).toHaveBeenCalledOnce()
  sink.write.mockRejectedValueOnce(new Error('Disk write failed'))
  await expect(writeDownloadStream(chunks(), sink, () => {})).rejects.toThrow('Disk write failed')
  expect(sink.abort).toHaveBeenCalledOnce()
})
it('fallbackRejectsResourceOverflowWithoutTrimmingAndClosesInput', async () => {
  let released = false
  async function* large() { try { for (let index = 0; index <= WORKSPACE_DOWNLOAD_FALLBACK_BYTES / 1024 ** 2; index++) yield new Uint8Array(1024 ** 2) } finally { released = true } }
  await expect(collectDownloadBlob(large(), () => {})).rejects.toThrow(/stream|limit|large/i)
  expect(released).toBe(true)
  expect(new Uint8Array(await (await collectDownloadBlob(chunks(), () => {})).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
})
it('profileChangeBeforeCloseAbortsInsteadOfClaimingDownload', async () => {
  let calls = 0
  const sink = { write: vi.fn(async () => {}), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) }
  await expect(writeDownloadStream(chunks(), sink, () => { if (++calls === 5) throw new Error('Profile changed') })).rejects.toThrow()
  expect(sink.close).not.toHaveBeenCalled()
  expect(sink.abort).toHaveBeenCalledOnce()
})
