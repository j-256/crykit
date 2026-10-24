import type { JsonValue, RevisionContext, RevisionDescriptor } from './types'

export function encodeContext(context: readonly JsonValue[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(context))
}
function revisionTuple(context: RevisionContext): readonly JsonValue[] {
  return [context.format, context.accountId, context.documentId, context.revisionId, context.parents, context.dependencies.map(dependency => [dependency.documentId, dependency.revisionId]), context.protected, context.plainBytes]
}
export function streamContext(context: RevisionContext, index: number): Uint8Array {
  return encodeContext([...revisionTuple(context), index])
}
export function descriptorContext(descriptor: Omit<RevisionDescriptor, 'keyEnvelope'>): readonly JsonValue[] {
  // Authenticate metadata after streaming, avoiding a circular key-envelope or stream digest
  return [...revisionTuple(descriptor), descriptor.streamHeader, descriptor.uploadId, descriptor.chunks.map(chunk => [chunk.index, chunk.cipherBytes, chunk.cipherDigest])]
}
