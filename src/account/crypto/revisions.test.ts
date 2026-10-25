import { afterEach, describe, expect, it, vi } from 'vitest'
import { plainChunkBytes, RevisionDescriptorSchema } from '../protocol'
import { encryptRevision, decryptRevision } from './revisions'
import { deriveWrappingKey, unwrapSecret, wrapSecret } from './envelopes'
import { descriptorContext, streamContext } from './context'
import { getSodium, releaseStreamState } from './sodium'
import type { PlainSink, RevisionContext } from './types'

afterEach(() => vi.restoreAllMocks())

const id = (value: number) => Buffer.alloc(16, value).toString('base64url')
const key = new Uint8Array(32).fill(7)
const context: RevisionContext = { format: 1, accountId: id(1), documentId: id(2), revisionId: id(3), parents: [id(4)], dependencies: [{ documentId: id(5), revisionId: id(6) }], protected: true, plainBytes: 0 }
async function* source(parts: readonly Uint8Array[]) { yield* parts }
function plainSink() {
  const staged: Uint8Array[] = []
  let published = new Uint8Array([99])
  return {
    committed: false, aborted: false,
    async write(bytes: Uint8Array) { staged.push(bytes.slice()) },
    async commit() { published = new Uint8Array(Buffer.concat(staged)); this.committed = true },
    async abort() { staged.length = 0; this.aborted = true },
    value: () => published,
  } satisfies PlainSink & { committed: boolean; aborted: boolean; value(): Uint8Array }
}
async function encrypt(payload: Uint8Array, parts = [payload]) {
  const chunks: Uint8Array[] = []
  const result = await encryptRevision(key, { ...context, plainBytes: payload.length }, id(8), source(parts), { id: 'private-stage', async write(index, bytes) { expect(index).toBe(chunks.length); chunks.push(bytes.slice()) } })
  return { ...result, chunks }
}

describe('authenticated immutable revisions', () => {
  it('decrypts the exact captured ciphertext when the producer changes its buffer during native hashing', async () => {
    const payload = new Uint8Array([1, 2, 3]), encrypted = await encrypt(payload)
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'digest').mockImplementation((algorithm, data) => {
      const pending = digest(algorithm, data)
      encrypted.chunks[0].fill(0)
      return pending
    })
    const sink = plainSink()
    await decryptRevision(key, encrypted.descriptor, source(encrypted.chunks), sink)
    expect(sink.value()).toEqual(payload)
    expect(sink.committed).toBe(true)
  })
  it.each([0, 1, 4 * 1024 * 1024, 4 * 1024 * 1024 + 23])('authenticatesEmptyBoundaryAndMultiChunkPayloads (%i bytes)', async size => {
    const payload = new Uint8Array(size).fill(42)
    const { descriptor, stagedPayloadId, chunks } = await encrypt(payload, [payload.subarray(0, 13), payload.subarray(13)])
    expect(plainChunkBytes).toBe(4 * 1024 * 1024)
    expect(descriptor.chunks.map(chunk => chunk.cipherBytes)).toEqual(size > plainChunkBytes ? [plainChunkBytes + 17, 23 + 17] : [size + 17])
    expect(stagedPayloadId).toBe('private-stage')
    expect(RevisionDescriptorSchema.safeParse(descriptor).success).toBe(true)
    const sink = plainSink()
    await decryptRevision(key, descriptor, source(chunks), sink)
    // Compare every byte natively instead of visiting millions of typed-array properties
    expect(Buffer.compare(sink.value(), payload)).toBe(0)
    expect(sink.committed).toBe(true)
    expect(sink.aborted).toBe(false)
  })

  it.each(['tamper', 'truncate', 'reorder', 'extra', 'account', 'parent', 'dependency', 'protected', 'header', 'digest', 'length', 'upload', 'envelope'] as const)('rejectsTamperTruncationReorderContextAndExtraChunks: %s', async change => {
    const result = await encrypt(new Uint8Array(plainChunkBytes + 1).fill(42))
    const descriptor = structuredClone(result.descriptor)
    let chunks = result.chunks.map(chunk => chunk.slice())
    switch (change) {
      case 'tamper': chunks[0][0] ^= 1; break
      case 'truncate': chunks = chunks.slice(0, 1); break
      case 'reorder': chunks.reverse(); break
      case 'extra': chunks.push(chunks[0]); break
      case 'account': descriptor.accountId = id(9); break
      case 'parent': descriptor.parents = [id(9)]; break
      case 'dependency': descriptor.dependencies = []; break
      case 'protected': descriptor.protected = false; break
      case 'header': descriptor.streamHeader = Buffer.alloc(24, 9).toString('base64url'); break
      case 'digest': descriptor.chunks = descriptor.chunks.map((chunk, index) => index ? chunk : { ...chunk, cipherDigest: Buffer.alloc(32, 9).toString('base64url') }); break
      case 'length': descriptor.plainBytes--; break
      case 'upload': descriptor.uploadId = id(9); break
      case 'envelope': descriptor.keyEnvelope.ciphertext = Buffer.alloc(48, 9).toString('base64url'); break
    }
    const sink = plainSink()
    await expect(decryptRevision(key, descriptor, source(chunks), sink)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(sink.committed).toBe(false)
    expect(sink.aborted).toBe(true)
    expect(sink.value()).toEqual(new Uint8Array([99]))
  })

  it('requires a final tag even when the authenticated descriptor and digest match', async () => {
    const s = await getSodium()
    const result = await encrypt(new Uint8Array([1]))
    const documentKey = await unwrapSecret(result.descriptor.keyEnvelope, key, descriptorContext(result.descriptor))
    const stream = s.crypto_secretstream_xchacha20poly1305_init_push(documentKey)
    const ciphertext = s.crypto_secretstream_xchacha20poly1305_push(stream.state, new Uint8Array([1]), streamContext(result.descriptor, 0), s.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)
    const descriptor = { ...result.descriptor, streamHeader: s.to_base64(stream.header, s.base64_variants.URLSAFE_NO_PADDING), chunks: [{ index: 0, cipherBytes: ciphertext.length, cipherDigest: s.to_base64(s.crypto_hash_sha256(ciphertext), s.base64_variants.URLSAFE_NO_PADDING) }] }
    releaseStreamState(s, stream.state)
    descriptor.keyEnvelope = await wrapSecret(documentKey, key, descriptorContext(descriptor))
    const pull = vi.spyOn(s, 'crypto_secretstream_xchacha20poly1305_pull')
    const sink = plainSink()
    await expect(decryptRevision(key, descriptor, source([ciphertext]), sink)).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    expect(sink.committed).toBe(false)
    const pulled = pull.mock.results[0].value as unknown as { message: Uint8Array }
    expect(pulled.message).toEqual(new Uint8Array([0]))
  })

  it('uses the fixed versioned tuple encoding at the stream and descriptor boundaries', async () => {
    const descriptor = (await encrypt(new Uint8Array([1]))).descriptor
    const tuple = [1, id(1), id(2), id(3), [id(4)], [[id(5), id(6)]], true, 1]
    expect(new TextDecoder().decode(streamContext(descriptor, 0))).toBe(JSON.stringify([...tuple, 0]))
    expect(descriptorContext(descriptor)).toEqual([...tuple, descriptor.streamHeader, id(8), descriptor.chunks.map(chunk => [chunk.index, chunk.cipherBytes, chunk.cipherDigest])])
  })

  it.each(['success', 'source-failure', 'sink-failure'] as const)('clears and frees owned stream state after its final use: %s', async outcome => {
    const s = await getSodium()
    const raw = (s as unknown as { libsodium: { HEAPU8: Uint8Array; _free(address: number): void; _crypto_secretstream_xchacha20poly1305_statebytes(): number } }).libsodium
    const initialize = vi.spyOn(s, 'crypto_secretstream_xchacha20poly1305_init_push')
    const released: number[] = []
    const free = raw._free.bind(raw)
    vi.spyOn(raw, '_free').mockImplementation(address => {
      if (initialize.mock.results.some(result => result.type === 'return' && (result.value.state as unknown) === address) && !released.includes(address)) {
        expect(raw.HEAPU8.subarray(address, address + raw._crypto_secretstream_xchacha20poly1305_statebytes()).every(byte => byte === 0)).toBe(true)
        released.push(address)
      }
      free(address)
    })
    async function* input() {
      if (outcome === 'source-failure') throw new Error('synthetic source failure')
      yield new Uint8Array([1])
    }
    const operation = encryptRevision(key, { ...context, plainBytes: 1 }, id(8), input(), { id: 'stage', async write() { if (outcome === 'sink-failure') throw new Error('synthetic sink failure') } })
    if (outcome === 'success') await operation
    else await expect(operation).rejects.toThrow('synthetic')
    expect(released).toHaveLength(1)
    expect(key).toEqual(new Uint8Array(32).fill(7))
  })

  it.each(['success', 'integrity-failure', 'sink-failure'] as const)('clears and frees decrypt state after its final use: %s', async outcome => {
    const encrypted = await encrypt(new Uint8Array([1]))
    const s = await getSodium()
    const raw = (s as unknown as { libsodium: { HEAPU8: Uint8Array; _free(address: number): void; _crypto_secretstream_xchacha20poly1305_statebytes(): number } }).libsodium
    const initialize = vi.spyOn(s, 'crypto_secretstream_xchacha20poly1305_init_pull')
    const released: number[] = []
    const free = raw._free.bind(raw)
    vi.spyOn(raw, '_free').mockImplementation(address => {
      if (initialize.mock.results.some(result => result.type === 'return' && (result.value as unknown) === address) && !released.includes(address)) {
        expect(raw.HEAPU8.subarray(address, address + raw._crypto_secretstream_xchacha20poly1305_statebytes()).every(byte => byte === 0)).toBe(true)
        released.push(address)
      }
      free(address)
    })
    if (outcome === 'integrity-failure') encrypted.chunks[0][0] ^= 1
    const sink = plainSink()
    if (outcome === 'sink-failure') sink.write = async () => { throw new Error('synthetic sink failure') }
    const operation = decryptRevision(key, encrypted.descriptor, source(encrypted.chunks), sink)
    if (outcome === 'success') { await operation; expect(sink.value()).toEqual(new Uint8Array([1])) }
    else { await expect(operation).rejects.toThrow(); expect(sink.aborted).toBe(true) }
    expect(released).toHaveLength(1)
    expect(key).toEqual(new Uint8Array(32).fill(7))
  })

  it('stages ciphertext with fresh document keys and headers, without private sentinels', async () => {
    const sentinel = new TextEncoder().encode('PRIVATE_SYNTHETIC_REVISION_SENTINEL')
    const a = await encrypt(sentinel)
    const b = await encrypt(sentinel)
    expect(Buffer.concat(a.chunks).includes(Buffer.from(sentinel))).toBe(false)
    expect(a.descriptor.streamHeader).not.toBe(b.descriptor.streamHeader)
    expect(await unwrapSecret(a.descriptor.keyEnvelope, key, descriptorContext(a.descriptor))).not.toEqual(await unwrapSecret(b.descriptor.keyEnvelope, key, descriptorContext(b.descriptor)))
  })

  it('writes each bounded chunk before requesting more plaintext', async () => {
    let written = 0
    async function* boundedSource() {
      yield new Uint8Array(plainChunkBytes)
      expect(written).toBe(1)
      yield new Uint8Array(1)
    }
    await encryptRevision(key, { ...context, plainBytes: plainChunkBytes + 1 }, id(8), boundedSource(), { id: 'bounded', async write() { written++ } })
    expect(written).toBe(2)
  })

  it.each([0, 2])('rejects source length %i when the context declares one byte', async length => {
    await expect(encryptRevision(key, { ...context, plainBytes: 1 }, id(8), source([new Uint8Array(length)]), { id: 'stage', async write() {} })).rejects.toMatchObject({ code: 'INVALID_CRYPTO_INPUT' })
  })

  it.each(['integrity', 'write', 'commit'] as const)('retains the primary %s failure when abort also rejects', async operation => {
    const encrypted = await encrypt(new Uint8Array([1]))
    const primaryFailure = new Error('synthetic primary storage failure')
    const abortFailure = new Error('synthetic abort failure')
    const sink = plainSink()
    sink.abort = async () => { throw abortFailure }
    if (operation === 'integrity') encrypted.chunks[0][0] ^= 1
    else sink[operation] = async () => { throw primaryFailure }
    const failure = await decryptRevision(key, encrypted.descriptor, source(encrypted.chunks), sink).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    if (!(failure instanceof AggregateError)) throw new Error('Expected both failures')
    expect(failure.errors[1]).toBe(abortFailure)
    expect(failure.cause).toBe(failure.errors[0])
    if (operation === 'integrity') expect(failure.errors[0]).toMatchObject({ code: 'INTEGRITY_FAILED' })
    else expect(failure.errors[0]).toBe(primaryFailure)
    expect(sink.committed).toBe(false)
    expect(sink.value()).toEqual(new Uint8Array([99]))
  })

  it('aborts on a staging or publication failure and preserves its local error', async () => {
    const result = await encrypt(new Uint8Array([1]))
    const failure = new Error('synthetic disk failure')
    for (const operation of ['write', 'commit'] as const) {
      const sink = plainSink()
      sink[operation] = async () => { throw failure }
      await expect(decryptRevision(key, result.descriptor, source(result.chunks), sink)).rejects.toBe(failure)
      expect(sink.aborted).toBe(true)
      expect(sink.value()).toEqual(new Uint8Array([99]))
    }
  })
})

describe('key envelopes and wrapping domains', () => {
  it('binds nonce, account context and keys without serializing plaintext', async () => {
    const envelope = await wrapSecret(key, new Uint8Array(32).fill(3), [1, id(1), 'account'])
    expect(await unwrapSecret(envelope, new Uint8Array(32).fill(3), [1, id(1), 'account'])).toEqual(key)
    expect(envelope.ciphertext).not.toContain(Buffer.from(key).toString('base64url'))
    await expect(unwrapSecret(envelope, new Uint8Array(32).fill(4), [1, id(1), 'account'])).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(unwrapSecret(envelope, new Uint8Array(32).fill(3), [1, id(2), 'account'])).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(unwrapSecret({ ...envelope, nonce: Buffer.alloc(24).toString('base64url') }, new Uint8Array(32).fill(3), [1, id(1), 'account'])).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
    await expect(wrapSecret(new Uint8Array(31), key, [])).rejects.toMatchObject({ code: 'INVALID_CRYPTO_INPUT' })
  })

  it.each(['success', 'import-failure'] as const)('clears the owned HKDF input copy after %s without clearing caller memory', async outcome => {
    const secret = new Uint8Array(64).fill(12)
    const failure = new Error('synthetic WebCrypto import failure')
    const imported = vi.spyOn(crypto.subtle, 'importKey')
    if (outcome === 'import-failure') imported.mockRejectedValueOnce(failure)
    const operation = deriveWrappingKey(secret, id(1), 'password')
    if (outcome === 'success') expect(await operation).toHaveLength(32)
    else await expect(operation).rejects.toBe(failure)
    const copied = imported.mock.calls[0][1]
    expect(copied).toBeInstanceOf(Uint8Array)
    if (!(copied instanceof Uint8Array)) throw new Error('Expected an owned byte copy')
    expect(copied).not.toBe(secret)
    expect(copied).toEqual(new Uint8Array(64))
    expect(secret).toEqual(new Uint8Array(64).fill(12))
  })

  it('derives standard HKDF-SHA-256 with separate account and credential roles', async () => {
    const secret = new Uint8Array(64).fill(12)
    const password = await deriveWrappingKey(secret, id(1), 'password')
    const input = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
    const expected = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(id(1)), info: new TextEncoder().encode('crykit/password-wrap/v1') }, input, 256)
    expect(password).toEqual(new Uint8Array(expected))
    expect(await deriveWrappingKey(secret, id(1), 'recovery')).not.toEqual(password)
    expect(await deriveWrappingKey(secret, id(2), 'password')).not.toEqual(password)
  })
})
