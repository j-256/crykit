export type { JsonValue } from '../../domain/types'
export type { KeyEnvelope, RevisionContext, RevisionDescriptor } from '../protocol'
import type { RevisionDescriptor } from '../protocol'

export type AccountKey = Uint8Array
export const accountKeyBytes = 32

export interface CipherSink {
  readonly id: string
  write(index: number, bytes: Uint8Array): Promise<void>
}

// Writes persist or copy bytes before resolving; the decryptor clears its scratch buffer
// A streaming sink may deliver an authenticated early chunk; commit proves whole-stream completion
// Abort clears sink-owned staging but cannot retract plaintext a consumer already copied
// Abort rejection retains both errors in an AggregateError with the primary failure as cause
export interface PlainSink {
  write(bytes: Uint8Array): Promise<void>
  commit(): Promise<void>
  abort(): Promise<void>
}

export interface EncryptedRevision {
  readonly descriptor: RevisionDescriptor
  readonly stagedPayloadId: string
}

export type CryptoErrorCode = 'INTEGRITY_FAILED' | 'INVALID_CRYPTO_INPUT' | 'UNSUPPORTED_LOCAL_ENVELOPE' | 'LOCAL_KDF_FAILED'
export class CryptoError extends Error {
  constructor(readonly code: CryptoErrorCode) { super(code); this.name = 'CryptoError' }
}

export function assertKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== accountKeyBytes) throw new CryptoError('INVALID_CRYPTO_INPUT')
}
