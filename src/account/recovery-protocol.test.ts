import { expect, it } from 'vitest'
import { RecoveryBindingSchema, RecoveryPointSchema, RecoveryReserveSchema, RecoverySupersessionSchema, RecoverySupersessionReceiptSchema } from './recovery-protocol'

const id='AAAAAAAAAAAAAAAAAAAAAA',other='BBBBBBBBBBBBBBBBBBBBBA'
const revision={format:1,accountId:id,documentId:id,revisionId:id,uploadId:id,parents:[],dependencies:[],protected:false,plainBytes:16,keyEnvelope:{version:1,algorithm:'xchacha20poly1305-ietf',nonce:'A'.repeat(32),ciphertext:'A'.repeat(64)},streamHeader:'A'.repeat(32),chunks:[{index:0,cipherBytes:33,cipherDigest:'A'.repeat(43)}]}
const pending={version:1,operationId:id,state:'pending',sealed:false,reservedBytes:33,admittedBytes:18000,revisions:[revision],createdAt:0,completedAt:null,expiresAt:null,mutationId:null,acceptedAt:null}
it('rejectsExternalSnapshotDependenciesAndDuplicateCiphertextIdentities',()=>{
  const input={version:1,operationId:id,revisions:[revision],reservedBytes:33}
  expect(RecoveryReserveSchema.safeParse(input).success).toBe(true)
  for(const revisions of [[{...revision,parents:[other]}],[{...revision,dependencies:[{documentId:other,revisionId:other}]}],[revision,revision]]) expect(RecoveryReserveSchema.safeParse({...input,revisions}).success).toBe(false)
})
it('bindsOnlyAnEpochGuardedPublicationWithTheSameRecoveryIdentity',()=>{
  const publication={version:1,mutationId:other,revisions:[],heads:[{documentId:id,revisionId:id}],expected:[{documentId:id,revisionId:null}],expectedPublicationEpoch:0,recoveryOperationId:id}
  expect(RecoveryBindingSchema.safeParse({version:1,operationId:id,publication}).success).toBe(true)
  for(const patch of [{expectedPublicationEpoch:undefined},{recoveryOperationId:undefined},{recoveryOperationId:other}]) expect(RecoveryBindingSchema.safeParse({version:1,operationId:id,publication:{...publication,...patch}}).success).toBe(false)
})
it('rejectsImpossibleRecoveryLifecyclesAndRetentionDatesInResponses',()=>{
  expect(RecoveryPointSchema.safeParse(pending).success).toBe(true)
  expect(RecoveryPointSchema.safeParse({...pending,sealed:true,mutationId:other,acceptedAt:100}).success).toBe(true)
  const completed={...pending,state:'completed',sealed:true,mutationId:other,acceptedAt:100,completedAt:100,expiresAt:2592000100}
  expect(RecoveryPointSchema.safeParse(completed).success).toBe(true)
  for(const value of [{...pending,acceptedAt:100},{...pending,mutationId:other},{...pending,expiresAt:100},{...completed,sealed:false},{...completed,completedAt:101},{...completed,expiresAt:2592000101}]) expect(RecoveryPointSchema.safeParse(value).success).toBe(false)
})

it('keeps bound supersession strict while admitting an explicit sealed-unbound version', () => {
  const common = { operationId: id, successorOperationId: other, successorMutationId: other }
  const bound = { version: 1, ...common, mutationId: id }
  const unbound = { version: 2, ...common, predecessor: { kind: 'sealed-unbound' } }
  expect(RecoverySupersessionSchema.parse(bound)).toEqual(bound)
  expect(RecoverySupersessionSchema.safeParse(unbound).success).toBe(true)
  for (const input of [{ ...bound, predecessor: unbound.predecessor }, { ...unbound, mutationId: id }, { ...unbound, predecessor: { kind: 'bound' } }, { ...unbound, successorOperationId: id }, { ...unbound, version: 3 }]) expect(RecoverySupersessionSchema.safeParse(input).success).toBe(false)
  expect(RecoverySupersessionReceiptSchema.parse({ version: 1, ...common })).toEqual({ version: 1, ...common })
})
