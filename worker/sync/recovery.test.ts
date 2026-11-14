import { expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { command, customer, direct, fixture, id, post, prepared } from './testing'
import type { RevisionDescriptor } from '../../src/account/protocol'

function snapshot(accountId: string) {
  const bytes = randomBytes(33)
  const descriptor: RevisionDescriptor = { format: 1, accountId, documentId: id(), revisionId: id(), uploadId: id(), parents: [], dependencies: [], protected: false, plainBytes: 16, keyEnvelope: { version: 1, algorithm: 'xchacha20poly1305-ietf', nonce: randomBytes(24).toString('base64url'), ciphertext: randomBytes(48).toString('base64url') }, streamHeader: randomBytes(24).toString('base64url'), chunks: [{ index: 0, cipherBytes: 33, cipherDigest: createHash('sha256').update(bytes).digest('base64url') }] }
  return { bytes, descriptor, input: { version: 1, operationId: id(), revisions: [descriptor], reservedBytes: 33 } }
}

it('reservesAtMostThreePendingPointsAndRejectsChangedRetries', async () => {
  const f = await fixture(), signed = await customer(f), first = snapshot(signed.accountId)
  const reserved = await post(f, 'sync/recoveries', first.input, signed.headers)
  expect(reserved.status).toBe(200)
  const point = await reserved.json()
  expect(await (await post(f, 'sync/recoveries', first.input, signed.headers)).json()).toEqual(point)
  expect((await post(f, 'sync/recoveries', { ...first.input, reservedBytes: 34 }, signed.headers)).status).toBe(409)
  for (let i = 0; i < 2; i++) expect((await post(f, 'sync/recoveries', snapshot(signed.accountId).input, signed.headers)).status).toBe(200)
  expect((await post(f, 'sync/recoveries', snapshot(signed.accountId).input, signed.headers)).status).toBe(413)
})

it('concurrentReservationsCannotOverbookTheAccount', async () => {
  const f = await fixture(), signed = await customer(f)
  const results = await Promise.all(Array.from({ length: 4 }, () => post(f, 'sync/recoveries', snapshot(signed.accountId).input, signed.headers)))
  expect(results.map(result => result.status).sort()).toEqual([200, 200, 200, 413])
})

it('requiresCompleteDedicatedCiphertextBeforeSealingAndDeniesOtherAccounts', async () => {
  const f = await fixture(), signed = await customer(f), other = await customer(f, 'other'), item = snapshot(signed.accountId)
  expect((await post(f, 'sync/recoveries', item.input, signed.headers)).status).toBe(200)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/seal`, { version: 1 }, signed.headers)).status).toBe(422)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/seal`, { version: 1 }, other.headers)).status).toBe(404)
  expect((await post(f, 'sync/recoveries', { ...snapshot(signed.accountId).input, revisions: [{ ...item.descriptor, parents: [id()] }] }, signed.headers)).status).toBe(400)
})

async function upload(f: Awaited<ReturnType<typeof fixture>>, signed: Awaited<ReturnType<typeof customer>>, item: ReturnType<typeof snapshot>) {
  const d = item.descriptor
  const input = { version: 1, uploadId: d.uploadId, documentId: d.documentId, revisionId: d.revisionId, metadataBytes: Buffer.byteLength(JSON.stringify(d)), chunks: d.chunks }
  expect((await post(f, 'sync/uploads', input, signed.headers)).status).toBe(200)
  expect((await f.request(`/api/v1/sync/uploads/${d.uploadId}/chunks/0`, { method: 'PUT', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/octet-stream', ...signed.headers }, body: item.bytes })).status).toBe(200)
  expect((await post(f, `sync/uploads/${d.uploadId}/finish`, { version: 1 }, signed.headers)).status).toBe(200)
  return input
}
async function sealed(f: Awaited<ReturnType<typeof fixture>>, signed: Awaited<ReturnType<typeof customer>>) {
  const item = snapshot(signed.accountId)
  expect((await post(f, 'sync/recoveries', item.input, signed.headers)).status).toBe(200)
  await upload(f, signed, item)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/seal`, { version: 1 }, signed.headers)).status).toBe(200)
  return item
}

it('transfersUploadQuotaWithoutLeakingDescriptorReservationsAndProtectsSealedPendingPayload', async () => {
  const f = await fixture(), signed = await customer(f), item = snapshot(signed.accountId)
  expect((await post(f, 'sync/recoveries', item.input, signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT reserved_metadata FROM quota_counters WHERE scope=?').bind(signed.accountId).first('reserved_metadata')).toBe(97)
  await upload(f, signed, item)
  expect(await f.db.prepare('SELECT reserved_metadata FROM quota_counters WHERE scope=?').bind(signed.accountId).first('reserved_metadata')).toBe(0)
  expect(await f.db.prepare('SELECT payload_bytes FROM quota_counters WHERE scope=?').bind(signed.accountId).first('payload_bytes')).toBe(97)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/seal`, { version: 1 }, signed.headers)).status).toBe(200)
  const { cleanupExpiredUploads } = await import('./storage')
  const { context } = await direct(f, signed, 1_800_000_000_000 + 31 * 86400000)
  expect(await cleanupExpiredUploads(context)).toBe(0)
  expect((await f.request(`/api/v1/sync/recoveries/${item.input.operationId}/revisions/${item.descriptor.revisionId}/chunks/0`, { headers: signed.headers })).status).toBe(200)
  expect((await post(f, 'sync/commits', command([item.descriptor]), signed.headers)).status).toBe(422)
  expect((await f.db.prepare('SELECT * FROM sync_revisions').all()).results).toHaveLength(0)
})

it('keepsUnsealedReservationWhileExpiredTransportCanCloseAndRevive', async () => {
  const f = await fixture(), signed = await customer(f), item = snapshot(signed.accountId)
  expect((await post(f, 'sync/recoveries', item.input, signed.headers)).status).toBe(200)
  const input = await upload(f, signed, item)
  const { cleanupExpiredUploads } = await import('./storage')
  const { context } = await direct(f, signed, 1_800_000_000_000 + 2 * 86400000)
  expect(await cleanupExpiredUploads(context)).toBe(1)
  expect(await f.db.prepare('SELECT reserved_metadata FROM quota_counters WHERE scope=?').bind(signed.accountId).first('reserved_metadata')).toBe(65)
  expect((await post(f, 'sync/uploads', input, signed.headers)).status).toBe(200)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/seal`, { version: 1 }, signed.headers)).status).toBe(422)
  await upload(f, signed, item)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/seal`, { version: 1 }, signed.headers)).status).toBe(200)
})

it('bindsOnlySealedPointsAndStartsRetentionAtAtomicPublicationAcceptance', async () => {
  const f = await fixture(), signed = await customer(f), item = snapshot(signed.accountId), target = await prepared(f, signed)
  const publication = { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: item.input.operationId }
  const binding = { version: 1, operationId: item.input.operationId, publication }
  expect((await post(f, 'sync/recoveries', item.input, signed.headers)).status).toBe(200)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/bind`, binding, signed.headers)).status).toBe(422)
  expect((await post(f, 'sync/commits', publication, signed.headers)).status).toBe(422)
  await upload(f, signed, item)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/seal`, { version: 1 }, signed.headers)).status).toBe(200)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/bind`, binding, signed.headers)).status).toBe(200)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/complete`, { version: 1 }, signed.headers)).status).toBe(422)
  const { recoveryOperationId: _omitted, ...withoutRecovery } = publication
  expect((await post(f, 'sync/commits', withoutRecovery, signed.headers)).status).toBe(422)
  expect((await post(f, 'sync/commits', publication, signed.headers)).status).toBe(200)
  f.advance(3600000)
  const response = await post(f, `sync/recoveries/${item.input.operationId}/complete`, { version: 1 }, signed.headers)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ state: 'completed', acceptedAt: 1_800_000_000_000, completedAt: 1_800_000_000_000, expiresAt: 1_802_592_000_000 })
})

it('rejectsRecoveryAdoptionOfPublishedUploadsAndReservesAccountByteLiability', async () => {
  const f = await fixture(), signed = await customer(f), item = await prepared(f, signed)
  expect((await post(f, 'sync/commits', command([item.descriptor]), signed.headers)).status).toBe(200)
  expect((await post(f, 'sync/recoveries', { version: 1, operationId: id(), revisions: [item.descriptor], reservedBytes: 33 }, signed.headers)).status).toBe(422)
  const used = await f.db.prepare('SELECT payload_bytes+reserved_metadata+metadata_bytes AS used FROM quota_counters WHERE scope=?').bind(signed.accountId).first<number>('used')
  await f.db.prepare('UPDATE accounts SET capacity_bytes=? WHERE id=?').bind(used! + 1, signed.accountId).run()
  expect((await post(f, 'sync/recoveries', snapshot(signed.accountId).input, signed.headers)).status).toBe(413)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM account_recoveries').first('n')).toBe(0)
})

async function completed(f: Awaited<ReturnType<typeof fixture>>, signed: Awaited<ReturnType<typeof customer>>) {
  const item = await sealed(f, signed), target = await prepared(f, signed)
  const epoch = await f.db.prepare('SELECT publication_epoch FROM account_sequences WHERE account_id=?').bind(signed.accountId).first<number>('publication_epoch')
  const publication = { ...command([target.descriptor]), expectedPublicationEpoch: epoch ?? 0, recoveryOperationId: item.input.operationId }
  expect((await post(f, `sync/recoveries/${item.input.operationId}/bind`, { version: 1, operationId: item.input.operationId, publication }, signed.headers)).status).toBe(200)
  expect((await post(f, 'sync/commits', publication, signed.headers)).status).toBe(200)
  expect((await post(f, `sync/recoveries/${item.input.operationId}/complete`, { version: 1 }, signed.headers)).status).toBe(200)
  return item
}
it('evictsOnlyOldestCompletedPointAndKeepsOperationTombstonesAfterFencing', async () => {
  const f = await fixture(), signed = await customer(f), oldest = await completed(f, signed)
  f.advance(1000)
  const newer = await completed(f, signed), pending = await sealed(f, signed), next = snapshot(signed.accountId)
  expect((await post(f, 'sync/recoveries', next.input, signed.headers)).status).toBe(200)
  const listed = await (await f.request('/api/v1/sync/recoveries', { headers: signed.headers })).json() as { points: { operationId: string }[] }
  expect(listed.points.map(p => p.operationId).sort()).toEqual([newer.input.operationId, pending.input.operationId, next.input.operationId].sort())
  expect(await f.db.prepare('SELECT state FROM storage_generations g JOIN upload_reservations u ON g.id=u.generation WHERE u.upload_id=?').bind(oldest.descriptor.uploadId).first('state')).toBe('closed')
  expect((await post(f, 'sync/recoveries', { ...snapshot(signed.accountId).input, operationId: oldest.input.operationId }, signed.headers)).status).toBe(404)
  expect((await post(f, `sync/recoveries/${pending.input.operationId}/remove`, { version: 1 }, signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT state FROM account_recoveries WHERE operation_id=?').bind(pending.input.operationId).first('state')).toBe('pending')
})
it('expiryOnlyReleasesCompletedPointsAtTheAcceptedDeadline', async () => {
  const f = await fixture(), signed = await customer(f), item = await completed(f, signed), pending = await sealed(f, signed)
  const { context } = await direct(f, signed)
  const { cleanupExpiredRecoveries } = await import('./recovery')
  expect(await cleanupExpiredRecoveries({ ...context, now: () => context.now()+30*86400000-1 })).toBe(0)
  expect(await cleanupExpiredRecoveries({ ...context, now: () => context.now()+30*86400000 })).toBe(1)
  expect(await f.db.prepare('SELECT operation_id FROM account_recoveries').first('operation_id')).toBe(pending.input.operationId)
  expect(await f.db.prepare('SELECT state FROM storage_generations g JOIN upload_reservations u ON g.id=u.generation WHERE u.upload_id=?').bind(item.descriptor.uploadId).first('state')).toBe('closed')
})
it('retiresCompletedRecoveryOwnershipWithoutFencingAnotherSnapshotOrReleasingItsQuota', async () => {
  const f = await fixture(), signed = await customer(f), item = await completed(f, signed)
  const generation = await f.db.prepare('SELECT generation FROM recovery_revisions WHERE operation_id=?').bind(item.input.operationId).first<string>('generation')
  const snapshotId = id()
  await f.db.prepare("INSERT INTO service_snapshots(id,source_generation,state,created_at,ledger,secrets,rows,bytes,reserve) VALUES(?,?,'complete',0,'{}','{}',0,0,0)").bind(snapshotId,id()).run()
  await f.db.prepare('INSERT INTO service_snapshot_pins(snapshot_id,generation) VALUES(?,?)').bind(snapshotId,generation).run()
  await sealed(f,signed); await sealed(f,signed)
  const before = await f.db.prepare('SELECT payload_bytes FROM quota_counters WHERE scope=?').bind(signed.accountId).first('payload_bytes')
  expect((await post(f,'sync/recoveries',snapshot(signed.accountId).input,signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT state FROM storage_generations WHERE id=?').bind(generation).first('state')).toBe('ready')
  expect(await f.db.prepare('SELECT payload_bytes FROM quota_counters WHERE scope=?').bind(signed.accountId).first('payload_bytes')).toBe(before)
  expect(await f.db.prepare('SELECT operation_id FROM account_recoveries WHERE operation_id=?').bind(item.input.operationId).first()).toBeNull()
  expect((await f.request(`/api/v1/sync/recoveries/${item.input.operationId}/revisions/${item.descriptor.revisionId}/chunks/0`,{headers:signed.headers})).status).toBe(404)
})
it('unknownUnchangedEpochCannotRebindAndAcceptedMutationCannotBeSuperseded', async () => {
  const f = await fixture(), signed = await customer(f), item = await sealed(f, signed), target = await prepared(f, signed)
  const first = { ...command([target.descriptor]), expectedPublicationEpoch: 0, recoveryOperationId: item.input.operationId }
  const bind = (publication: typeof first, supersedesMutationId?: string) => post(f, `sync/recoveries/${item.input.operationId}/bind`, { version: 1, operationId: item.input.operationId, publication, ...(supersedesMutationId ? { supersedesMutationId } : {}) }, signed.headers)
  expect((await bind(first)).status).toBe(200)
  const next = { ...first, mutationId: id() }
  expect((await bind(next, first.mutationId)).status).toBe(409)
  const intervening = await prepared(f, signed)
  expect((await post(f, 'sync/commits', command([intervening.descriptor]), signed.headers)).status).toBe(200)
  next.expectedPublicationEpoch = 1
  expect((await bind(next)).status).toBe(409)
  expect((await bind(next, first.mutationId)).status).toBe(200)
  expect((await post(f, 'sync/commits', first, signed.headers)).status).toBe(422)
  expect((await post(f, 'sync/commits', next, signed.headers)).status).toBe(200)
  expect((await bind({ ...next, mutationId: id(), expectedPublicationEpoch: 2 }, next.mutationId)).status).toBe(409)
})

it('explicitCancellationFreesOnlyUnsealedUnboundSlotsAndPreventsOperationReplay', async () => {
  const f = await fixture(), signed = await customer(f), item = snapshot(signed.accountId)
  expect((await post(f,'sync/recoveries',item.input,signed.headers)).status).toBe(200)
  expect((await post(f,`sync/recoveries/${item.input.operationId}/cancel`,{version:1},signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM account_recoveries').first('n')).toBe(0)
  expect(await f.db.prepare('SELECT reserved_metadata FROM quota_counters WHERE scope=?').bind(signed.accountId).first('reserved_metadata')).toBe(0)
  expect((await post(f,'sync/recoveries',item.input,signed.headers)).status).toBe(404)
  expect((await post(f,'sync/recoveries',{...snapshot(signed.accountId).input,operationId:item.input.operationId},signed.headers)).status).toBe(404)
  const ready = await sealed(f,signed)
  expect(await (await post(f,`sync/recoveries/${ready.input.operationId}/cancel`,{version:1},signed.headers)).json()).toEqual({version:1,state:'blocked'})
})
it('concurrentSealAndCancellationCannotDiscardASealedRecovery', async () => {
  const f = await fixture(), signed = await customer(f), item = snapshot(signed.accountId)
  expect((await post(f,'sync/recoveries',item.input,signed.headers)).status).toBe(200)
  await upload(f,signed,item)
  const results = await Promise.all(['seal','cancel'].map(action=>post(f,`sync/recoveries/${item.input.operationId}/${action}`,{version:1},signed.headers)))
  const sealedRow = await f.db.prepare('SELECT sealed FROM account_recoveries WHERE operation_id=?').bind(item.input.operationId).first<{sealed:number}>()
  if (results[0].status===200) {
    expect(sealedRow).toEqual({sealed:1})
    expect(await results[1].json()).toEqual({version:1,state:'blocked'})
  } else {
    expect([404,422]).toContain(results[0].status)
    expect(sealedRow).toBeNull()
    expect((await post(f,'sync/recoveries',item.input,signed.headers)).status).toBe(404)
  }
})

it('identicalConcurrentReservationsReturnOnePoint', async () => {
  const f=await fixture(),signed=await customer(f),item=snapshot(signed.accountId)
  const responses=await Promise.all([post(f,'sync/recoveries',item.input,signed.headers),post(f,'sync/recoveries',item.input,signed.headers)])
  expect(responses.map(r=>r.status)).toEqual([200,200])
  expect(await responses[0].json()).toEqual(await responses[1].json())
  expect(await f.db.prepare('SELECT COUNT(*) n FROM account_recoveries').first('n')).toBe(1)
})
it('byteAdmissionIncludesCiphertextDescriptorsAndControlsWithinTheAccountAndRecoveryCaps', async () => {
  const f=await fixture(),signed=await customer(f),item=snapshot(signed.accountId)
  await f.db.prepare('UPDATE accounts SET capacity_bytes=? WHERE id=?').bind(2*1024*1024*1024,signed.accountId).run()
  const revisions=Array.from({length:32},()=>({...snapshot(signed.accountId).descriptor,plainBytes:4*1024*1024,chunks:[{index:0,cipherBytes:4*1024*1024+17,cipherDigest:item.descriptor.chunks[0].cipherDigest}]}))
  expect((await post(f,'sync/recoveries',{version:1,operationId:id(),revisions,reservedBytes:32*(4*1024*1024+17)},signed.headers)).status).toBe(413)
  await f.db.prepare('UPDATE accounts SET capacity_bytes=16000 WHERE id=?').bind(signed.accountId).run()
  expect((await post(f,'sync/recoveries',item.input,signed.headers)).status).toBe(413)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM account_recoveries').first('n')).toBe(0)
})
it.each(['recovery-wins','sync-wins'] as const)('atomicOwnershipExclusionSurvivesA%sRace',async winner=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed),{context,principal}=await direct(f,signed)
  const {reserveRecovery}=await import('./recovery'),{commitRevisions}=await import('./commit')
  const input={version:1 as const,operationId:id(),revisions:[item.descriptor],reservedBytes:33},publish=command([item.descriptor])
  let raced=false
  const db=new Proxy(f.db,{get(target,key){
    if(key==='batch')return async(...args:Parameters<typeof target.batch>)=>{
      if(!raced){raced=true;if(winner==='recovery-wins')await reserveRecovery(principal,input,context);else await commitRevisions(principal,publish,context)}
      return target.batch(...args)
    }
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  const competing={...context,env:{...context.env,DB:db}}
  await expect(winner==='recovery-wins'?commitRevisions(principal,publish,competing):reserveRecovery(principal,input,competing)).rejects.toThrow()
  expect(await f.db.prepare('SELECT COUNT(*) n FROM sync_revisions').first('n')).toBe(winner==='sync-wins'?1:0)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM account_recoveries').first('n')).toBe(winner==='recovery-wins'?1:0)
})

it('linksExplicitSupersessionOnlyAfterASealedSuccessorAndProofTheOldPublicationCannotAccept',async()=>{
  const f=await fixture(),signed=await customer(f),old=await sealed(f,signed),target=await prepared(f,signed)
  const oldPublication={...command([target.descriptor]),expectedPublicationEpoch:0,recoveryOperationId:old.input.operationId}
  expect((await post(f,`sync/recoveries/${old.input.operationId}/bind`,{version:1,operationId:old.input.operationId,publication:oldPublication},signed.headers)).status).toBe(200)
  const next=await sealed(f,signed),nextPublication={...oldPublication,mutationId:id(),recoveryOperationId:next.input.operationId}
  const request={version:1,operationId:old.input.operationId,mutationId:oldPublication.mutationId,successorOperationId:next.input.operationId,successorMutationId:nextPublication.mutationId}
  const supersede=()=>post(f,`sync/recoveries/${old.input.operationId}/supersede`,request,signed.headers)
  expect((await supersede()).status).toBe(409)
  expect((await post(f,`sync/recoveries/${next.input.operationId}/bind`,{version:1,operationId:next.input.operationId,publication:nextPublication},signed.headers)).status).toBe(200)
  expect((await supersede()).status).toBe(409)
  const intervening=await prepared(f,signed)
  expect((await post(f,'sync/commits',command([intervening.descriptor]),signed.headers)).status).toBe(200)
  const renewed={...nextPublication,mutationId:id(),expectedPublicationEpoch:1}
  expect((await post(f,`sync/recoveries/${next.input.operationId}/bind`,{version:1,operationId:next.input.operationId,publication:renewed,supersedesMutationId:nextPublication.mutationId},signed.headers)).status).toBe(200)
  request.successorMutationId=renewed.mutationId
  f.failNext('sync.recovery.superseded')
  expect((await supersede()).status).toBe(503)
  const response=await supersede()
  expect(response.status).toBe(200)
  const expected={version:1,operationId:request.operationId,successorOperationId:request.successorOperationId,successorMutationId:request.successorMutationId}
  expect(await response.json()).toEqual(expected)
  expect(await (await supersede()).json()).toEqual(expected)
  expect(await f.db.prepare('SELECT operation_id FROM account_recoveries WHERE operation_id=?').bind(old.input.operationId).first()).toBeNull()
  expect(await f.db.prepare('SELECT sealed FROM account_recoveries WHERE operation_id=?').bind(next.input.operationId).first('sealed')).toBe(1)
  expect((await post(f,'sync/commits',oldPublication,signed.headers)).status).toBe(422)
  expect((await post(f,'sync/recoveries',old.input,signed.headers)).status).toBe(404)
  expect((await post(f,`sync/recoveries/${old.input.operationId}/supersede`,{...request,successorOperationId:id()},signed.headers)).status).toBe(409)
})
it('supersessionCannotRetireAnAcceptedOldBinding',async()=>{
  const f=await fixture(),signed=await customer(f),old=await sealed(f,signed),target=await prepared(f,signed)
  const first={...command([target.descriptor]),expectedPublicationEpoch:0,recoveryOperationId:old.input.operationId}
  expect((await post(f,`sync/recoveries/${old.input.operationId}/bind`,{version:1,operationId:old.input.operationId,publication:first},signed.headers)).status).toBe(200)
  expect((await post(f,'sync/commits',first,signed.headers)).status).toBe(200)
  const next=await sealed(f,signed),nextTarget=await prepared(f,signed),publication={...command([nextTarget.descriptor]),expectedPublicationEpoch:1,recoveryOperationId:next.input.operationId}
  expect((await post(f,`sync/recoveries/${next.input.operationId}/bind`,{version:1,operationId:next.input.operationId,publication},signed.headers)).status).toBe(200)
  expect((await post(f,`sync/recoveries/${old.input.operationId}/supersede`,{version:1,operationId:old.input.operationId,mutationId:first.mutationId,successorOperationId:next.input.operationId,successorMutationId:publication.mutationId},signed.headers)).status).toBe(409)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM account_recoveries').first('n')).toBe(2)
})

it('aFreshDeviceCanCompleteTheAcceptedBindingAfterTheOriginalClientLosesItsResponse',async()=>{
  const f=await fixture(),signed=await customer(f),item=await sealed(f,signed),target=await prepared(f,signed)
  const publication={...command([target.descriptor]),expectedPublicationEpoch:0,recoveryOperationId:item.input.operationId}
  expect((await post(f,`sync/recoveries/${item.input.operationId}/bind`,{version:1,operationId:item.input.operationId,publication},signed.headers)).status).toBe(200)
  f.failNext('sync.commit.after')
  expect((await post(f,'sync/commits',publication,signed.headers)).status).toBe(503)
  const listed=await (await f.request('/api/v1/sync/recoveries',{headers:signed.headers})).json() as {points:{operationId:string;acceptedAt:number;mutationId:string}[]}
  expect(listed.points[0]).toMatchObject({operationId:item.input.operationId,mutationId:publication.mutationId,acceptedAt:1_800_000_000_000})
  const {completeRecovery}=await import('./recovery'),fresh=await direct(f,signed)
  expect(await completeRecovery(fresh.principal,listed.points[0].operationId,fresh.context)).toMatchObject({state:'completed',expiresAt:1_802_592_000_000})
})

it.each(['before','after'] as const)('cancellation%sFencedAccountingNeverDoubleTransfersTheRetryReservation',async position=>{
  const f=await fixture(),signed=await customer(f),item=snapshot(signed.accountId),{context,principal}=await direct(f,signed)
  expect((await post(f,'sync/recoveries',item.input,signed.headers)).status).toBe(200)
  await upload(f,signed,item)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id=?').bind(item.descriptor.uploadId).first<string>('generation')
  await f.db.prepare('UPDATE storage_generations SET expires_at=0 WHERE id=?').bind(generation).run()
  const {claimGenerationCleanup,fenceGeneration}=await import('./storage'),{cancelRecoveryPreparation}=await import('./recovery')
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(true)
  let cancelled=false
  const cancel=async()=>{if(!cancelled){cancelled=true;expect(await cancelRecoveryPreparation(principal,item.input.operationId,context)).toEqual({version:1,state:'complete'})}}
  const db=new Proxy(f.db,{get(target,key){
    if(key==='batch')return async(...args:Parameters<typeof target.batch>)=>{if(position==='before')await cancel();const result=await target.batch(...args);if(position==='after')await cancel();return result}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  expect(await fenceGeneration(generation!,{...context,env:{...context.env,DB:db}})).toBe(true)
  expect(await fenceGeneration(generation!,context)).toBe(true)
  expect(await f.db.prepare('SELECT reserved_metadata,payload_bytes FROM quota_counters WHERE scope=?').bind(signed.accountId).first()).toEqual({reserved_metadata:0,payload_bytes:32})
  expect(await f.db.prepare('SELECT COUNT(*) n FROM account_recoveries').first('n')).toBe(0)
})

it('cannotAdoptAlreadyFencedOrdinaryTransportAsAnUnchargedRecoveryReservation',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed),{context}=await direct(f,signed)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id=?').bind(item.input.uploadId).first<string>('generation')
  await f.db.prepare('UPDATE storage_generations SET expires_at=0 WHERE id=?').bind(generation).run()
  const {claimGenerationCleanup,fenceGeneration}=await import('./storage')
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(true)
  expect(await fenceGeneration(generation!,context)).toBe(true)
  expect((await post(f,'sync/recoveries',{version:1,operationId:id(),revisions:[item.descriptor],reservedBytes:33},signed.headers)).status).toBe(422)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM account_recoveries').first('n')).toBe(0)
})

it('completionObservesAcceptanceThatRacesItsInitialRead',async()=>{
  const f=await fixture(),signed=await customer(f),item=await sealed(f,signed),target=await prepared(f,signed),{context,principal}=await direct(f,signed)
  const publication={...command([target.descriptor]),expectedPublicationEpoch:0,recoveryOperationId:item.input.operationId}
  expect((await post(f,`sync/recoveries/${item.input.operationId}/bind`,{version:1,operationId:item.input.operationId,publication},signed.headers)).status).toBe(200)
  const {completeRecovery}=await import('./recovery'),{commitRevisions}=await import('./commit')
  let accepted=false
  const db=new Proxy(f.db,{get(target,key){
    if(key==='batch')return async(...args:Parameters<typeof target.batch>)=>{if(!accepted){accepted=true;await commitRevisions(principal,publication,context)}return target.batch(...args)}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  expect(await completeRecovery(principal,item.input.operationId,{...context,env:{...context.env,DB:db}})).toMatchObject({state:'completed',acceptedAt:1_800_000_000_000,completedAt:1_800_000_000_000,expiresAt:1_802_592_000_000})
})
it.each(['cancel','remove'] as const)('recovery%sCanReduceOwnershipAfterAnAdministratorLowersCapacity',async action=>{
  const f=await fixture(),signed=await customer(f)
  const item=action==='remove'?await completed(f,signed):snapshot(signed.accountId)
  if(action==='cancel')expect((await post(f,'sync/recoveries',item.input,signed.headers)).status).toBe(200)
  await f.db.prepare('UPDATE accounts SET capacity_bytes=1 WHERE id=?').bind(signed.accountId).run()
  const response=await post(f,`sync/recoveries/${item.input.operationId}/${action}`,{version:1},signed.headers)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({version:1,state:'complete'})
  expect(await f.db.prepare('SELECT COUNT(*) n FROM account_recoveries').first('n')).toBe(0)
})
