import type { StateAddress } from 'libsodium-wrappers-sumo'
import { OpaqueIdSchema, RevisionContextSchema, RevisionDescriptorSchema, plainChunkBytes } from '../protocol'
import { descriptorContext, streamContext } from './context'
import { unwrapSecret, wrapSecret } from './envelopes'
import { decodeBytes, encodeBytes, getSodium, releaseStreamState } from './sodium'
import { accountKeyBytes, assertKey, CryptoError } from './types'
import type { AccountKey, CipherSink, EncryptedRevision, PlainSink, RevisionContext, RevisionDescriptor } from './types'

export async function encryptRevision(key: AccountKey, context: RevisionContext, uploadId: string, source: AsyncIterable<Uint8Array>, sink: CipherSink): Promise<EncryptedRevision> {
  assertKey(key)
  const parsed = RevisionContextSchema.safeParse(context)
  if (!parsed.success || !OpaqueIdSchema.safeParse(uploadId).success) throw new CryptoError('INVALID_CRYPTO_INPUT')
  // Copy the validated graph before any await; caller mutation cannot change authenticated context
  context = parsed.data
  const sodium = await getSodium()
  const documentKey = sodium.randombytes_buf(accountKeyBytes)
  let state: StateAddress | undefined
  const buffer = new Uint8Array(Math.min(plainChunkBytes, context.plainBytes))
  try {
    const stream = sodium.crypto_secretstream_xchacha20poly1305_init_push(documentKey)
    state = stream.state
    const chunks: RevisionDescriptor['chunks'][number][] = []
    let buffered = 0
    let received = 0
    async function push(final: boolean) {
      const index = chunks.length
      const bytes = sodium.crypto_secretstream_xchacha20poly1305_push(stream.state, buffer.subarray(0, buffered), streamContext(context, index), final ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)
      chunks.push({ index, cipherBytes: bytes.length, cipherDigest: encodeBytes(sodium, sodium.crypto_hash_sha256(bytes)) })
      // Await each staged write before pulling more source: memory stays bounded independently of document size
      await sink.write(index, bytes)
      buffer.fill(0)
      buffered = 0
    }
    for await (const part of source) {
      if (!(part instanceof Uint8Array) || received + part.length > context.plainBytes) throw new CryptoError('INVALID_CRYPTO_INPUT')
      let offset = 0
      while (offset < part.length) {
        const length = Math.min(buffer.length - buffered, part.length - offset)
        buffer.set(part.subarray(offset, offset + length), buffered)
        buffered += length
        received += length
        offset += length
        if (buffered === buffer.length) await push(received === context.plainBytes)
      }
    }
    if (received !== context.plainBytes) throw new CryptoError('INVALID_CRYPTO_INPUT')
    if (buffered || !context.plainBytes) await push(true)
    const descriptorWithoutEnvelope = { ...context, streamHeader: encodeBytes(sodium, stream.header), uploadId, chunks }
    const keyEnvelope = await wrapSecret(documentKey, key, descriptorContext(descriptorWithoutEnvelope))
    return { descriptor: { ...descriptorWithoutEnvelope, keyEnvelope }, stagedPayloadId: sink.id }
  } finally {
    buffer.fill(0)
    sodium.memzero(documentKey)
    if (state !== undefined) releaseStreamState(sodium, state)
  }
}

export async function decryptRevision(key: AccountKey, descriptor: RevisionDescriptor, chunks: AsyncIterable<Uint8Array>, sink: PlainSink): Promise<void> {
  const sodium = await getSodium()
  let documentKey: Uint8Array | undefined
  let state: StateAddress | undefined
  try {
    assertKey(key)
    const parsed = RevisionDescriptorSchema.safeParse(descriptor)
    if (!parsed.success) throw new CryptoError('INTEGRITY_FAILED')
    descriptor = parsed.data
    documentKey = await unwrapSecret(descriptor.keyEnvelope, key, descriptorContext(descriptor))
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(decodeBytes(sodium, descriptor.streamHeader), documentKey)
    let count = 0
    let total = 0
    for await (const chunk of chunks) {
      const expected = descriptor.chunks[count]
      if (!expected || !(chunk instanceof Uint8Array) || chunk.length !== expected.cipherBytes || encodeBytes(sodium, sodium.crypto_hash_sha256(chunk)) !== expected.cipherDigest) throw new CryptoError('INTEGRITY_FAILED')
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk, streamContext(descriptor, count))
      if (!result) throw new CryptoError('INTEGRITY_FAILED')
      // A successful pull owns plaintext even when its authenticated tag violates the stream contract
      try {
        const final = count === descriptor.chunks.length - 1
        if (result.tag !== (final ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)) throw new CryptoError('INTEGRITY_FAILED')
        total += result.message.length
        await sink.write(result.message)
        count++
      } finally { sodium.memzero(result.message) }
    }
    if (count !== descriptor.chunks.length || total !== descriptor.plainBytes) throw new CryptoError('INTEGRITY_FAILED')
    // Commit marks whole-stream completion; a streaming sink may already have delivered early chunks
    await sink.commit()
  } catch (error) {
    try { await sink.abort() } catch (abortError) {
      // Cleanup failure must retain the original integrity/storage diagnostic for recovery
      throw new AggregateError([error, abortError], 'Decryption and staging abort failed', { cause: error })
    }
    throw error
  } finally {
    if (documentKey) sodium.memzero(documentKey)
    if (state !== undefined) releaseStreamState(sodium, state)
  }
}
