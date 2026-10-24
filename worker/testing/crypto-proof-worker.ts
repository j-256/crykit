import * as opaque from '../../src/account/crypto/opaque'
import { deriveWrappingKey, unwrapSecret, wrapSecret } from '../../src/account/crypto/envelopes'
import { decryptRevision, encryptRevision } from '../../src/account/crypto/revisions'
import { validatePassword } from '../../src/account/password-policy'
import type { KeyEnvelope, RevisionDescriptor } from '../../src/account/protocol'

const accountId = 'AAAAAAAAAAAAAAAAAAAAAA'
const credentialId = `crykit/password/${accountId}`
const plaintext = new TextEncoder().encode('synthetic private revision')
interface Payload { envelope: KeyEnvelope; descriptor: RevisionDescriptor }
interface Input { id: number; operation: string; password: string; state: string; response: string; payload: Payload; ciphertext: number[][] }
function encode(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
async function perform(input: Input): Promise<unknown> {
  if (input.operation === 'policy') return validatePassword(input.password)
  if (input.operation === 'start-registration') return opaque.startRegistration(input.password)
  if (input.operation === 'start-login') return opaque.startLogin(input.password)
  if (input.operation === 'finish-registration') {
    const registered = await opaque.finishRegistration(input.state, input.response, input.password, credentialId)
    const key = crypto.getRandomValues(new Uint8Array(32))
    const envelope = await wrapSecret(key, await deriveWrappingKey(registered.exportKey, accountId, 'password'), [1, accountId])
    const ciphertext: number[][] = []
    async function* source() { yield plaintext }
    const encrypted = await encryptRevision(key, { format: 1, accountId, documentId: accountId, revisionId: accountId, parents: [], dependencies: [], protected: false, plainBytes: plaintext.length }, accountId, source(), { id: 'synthetic', async write(_, bytes) { ciphertext.push(Array.from(bytes)) } })
    const result = { record: registered.record, payload: { envelope, descriptor: encrypted.descriptor }, ciphertext, key: Array.from(key), accountKeyEncoded: encode(key), exportKeyEncoded: encode(registered.exportKey), recoverySecret: encode(crypto.getRandomValues(new Uint8Array(32))) }
    key.fill(0)
    registered.exportKey.fill(0)
    return result
  }
  if (input.operation === 'finish-login') {
    const result = await opaque.finishLogin(input.state, input.response, input.password, credentialId)
    const key = await unwrapSecret(input.payload.envelope, await deriveWrappingKey(result.exportKey, accountId, 'password'), [1, accountId])
    async function* source() { for (const chunk of input.ciphertext) yield new Uint8Array(chunk) }
    const staged: Uint8Array[] = []
    let committed = false
    await decryptRevision(key, input.payload.descriptor, source(), { async write(bytes) { staged.push(bytes.slice()) }, async commit() { committed = true }, async abort() { staged.length = 0 } })
    if (!committed || new TextDecoder().decode(staged[0]) !== new TextDecoder().decode(plaintext)) throw new Error('PROOF_DECRYPTION_FAILED')
    const output = { key: Array.from(key), request: result.request }
    key.fill(0)
    result.exportKey.fill(0)
    return output
  }
  throw new Error('INVALID_PROBE')
}
self.addEventListener('message', async (event: MessageEvent<Input>) => {
  const started = performance.now()
  try { self.postMessage({ id: event.data.id, result: await perform(event.data), wallMs: performance.now() - started }) }
  catch (error) { self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : 'PROBE_FAILED', wallMs: performance.now() - started }) }
})
