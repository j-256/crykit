import { expect, it } from 'vitest'
import { randomBytes, createHash } from 'node:crypto'
import { fixture, customer, post, id } from './testing'
import { localProjectCapacityBytes } from '../../src/account/protocol'

it('reservesBeforeWritingAndRetriesOnlyIdenticalCiphertext', async () => {
  const f = await fixture(), signed = await customer(f)
  const bytes = randomBytes(33)
  const input = { version: 1, uploadId: id(), documentId: id(), revisionId: id(), metadataBytes: 1000, chunks: [{ index: 0, cipherBytes: bytes.length, cipherDigest: createHash('sha256').update(bytes).digest('base64url') }] }
  await f.db.prepare('UPDATE accounts SET capacity_bytes = 1 WHERE id = ?').bind(signed.accountId).run()
  expect((await post(f, 'sync/uploads', input, signed.headers)).status).toBe(413)
  expect((await f.objects.list()).objects).toHaveLength(0)
  await f.db.prepare('UPDATE accounts SET capacity_bytes = 1000000 WHERE id = ?').bind(signed.accountId).run()
  expect((await post(f, 'sync/uploads', input, signed.headers)).status).toBe(200)
  const put = (body: Buffer) => f.request(`/api/v1/sync/uploads/${input.uploadId}/chunks/0`, { method: 'PUT', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/octet-stream', ...signed.headers }, body })
  expect((await put(bytes)).status).toBe(200)
  expect((await put(bytes)).status).toBe(200)
  expect((await put(randomBytes(33))).status).toBe(409)
})

it('restrictionRacingFinishPreventsVisibility', async () => {
  const f = await fixture(), signed = await customer(f)
  const bytes = randomBytes(33)
  const input = { version: 1, uploadId: id(), documentId: id(), revisionId: id(), metadataBytes: 1000, chunks: [{ index: 0, cipherBytes: bytes.length, cipherDigest: createHash('sha256').update(bytes).digest('base64url') }] }
  expect((await post(f, 'sync/uploads', input, signed.headers)).status).toBe(200)
  expect((await f.request(`/api/v1/sync/uploads/${input.uploadId}/chunks/0`, { method: 'PUT', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/octet-stream', ...signed.headers }, body: bytes })).status).toBe(200)
  // The middleware observation succeeds, then the live final SQL predicate must reject
  await f.db.prepare(`CREATE TRIGGER restrict_finish AFTER UPDATE OF idle_expires_at ON customer_sessions BEGIN UPDATE accounts SET access = 'blocked' WHERE id = NEW.account_id; END`).run()
  expect((await post(f, `sync/uploads/${input.uploadId}/finish`, { version: 1 }, signed.headers)).status).toBe(403)
})
it('rejectsForeignOpaqueIds', async () => {
  const f = await fixture(), signed = await customer(f)
  const foreignRead = await f.request(`/api/v1/sync/revisions/${id()}`, { headers: signed.headers })
  expect(foreignRead.status).toBe(404)
  expect(foreignRead.headers.get('cache-control')).toBe('no-store')
})
it('lostCommitResponseChargesOnce', async () => {
  const f = await fixture(), signed = await customer(f)
  const bytes = randomBytes(33)
  const input = { version: 1, uploadId: id(), documentId: id(), revisionId: id(), metadataBytes: 1000, chunks: [{ index: 0, cipherBytes: bytes.length, cipherDigest: createHash('sha256').update(bytes).digest('base64url') }] }
  expect((await post(f, 'sync/uploads', input, signed.headers)).status).toBe(200)
  expect((await f.request(`/api/v1/sync/uploads/${input.uploadId}/chunks/0`, { method: 'PUT', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/octet-stream', ...signed.headers }, body: bytes })).status).toBe(200)
  expect((await post(f, `sync/uploads/${input.uploadId}/finish`, { version: 1 }, signed.headers)).status).toBe(200)
  const descriptor = { format: 1, accountId: signed.accountId, documentId: input.documentId, revisionId: input.revisionId, parents: [], dependencies: [], protected: false, plainBytes: 16, keyEnvelope: { version: 1, algorithm: 'xchacha20poly1305-ietf', nonce: randomBytes(24).toString('base64url'), ciphertext: randomBytes(48).toString('base64url') }, streamHeader: randomBytes(24).toString('base64url'), uploadId: input.uploadId, chunks: input.chunks }
  const commit = { version: 1, mutationId: id(), expected: [{ documentId: input.documentId, revisionId: null }], heads: [{ documentId: input.documentId, revisionId: input.revisionId }], revisions: [descriptor] }
  f.failNext('sync.commit.after')
  expect((await post(f, 'sync/commits', commit, signed.headers)).status).toBe(503)
  const before = await f.db.prepare('SELECT * FROM quota_counters ORDER BY scope').all()
  const retry = await post(f, 'sync/commits', commit, signed.headers)
  expect(retry.status).toBe(200)
  expect(await retry.json()).toEqual({ version: 1, mutationId: commit.mutationId, sequence: 1, publicationEpoch: 1, heads: commit.heads })
  expect((await f.db.prepare('SELECT * FROM quota_counters ORDER BY scope').all()).results).toEqual(before.results)
  expect((await post(f, 'sync/commits', { ...commit, expectedPublicationEpoch: 0 }, signed.headers)).status).toBe(409)
})

import { direct, prepared } from './testing'
import { claimGenerationCleanup, fenceGeneration, writeFencedChunk, decode } from './storage'
function deferred() { let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve} }
it.each(['initializer','body'] as const)('permanentMarkerFencesDelayed%sAfterClosureWithoutDelete', async phase => {
  const f=await fixture(), signed=await customer(f), {context,principal}=await direct(f,signed)
  const bytes=randomBytes(33), input={version:1,uploadId:id(),documentId:id(),revisionId:id(),metadataBytes:1000,chunks:[{index:0,cipherBytes:33,cipherDigest:createHash('sha256').update(bytes).digest('base64url')}]}
  expect((await post(f,'sync/uploads',input,signed.headers)).status).toBe(200)
  const row=await f.db.prepare('SELECT * FROM upload_chunks').first<{generation:string;object_key:string;marker:string}>()
  const started=deferred(), resume=deferred();let deletes=0
  const objects=new Proxy(context.env.OBJECTS!,{get(target,key){
    if(key==='delete') return ()=>{deletes++;throw new Error('Managed Delete forbidden')}
    if(key==='put') return async (...args: Parameters<typeof target.put>)=>{
      const options=args[2] as {onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}|undefined
      if ((phase==='initializer' && options?.onlyIf?.etagDoesNotMatch)||(phase==='body' && options?.onlyIf?.etagMatches)){started.resolve();await resume.promise}
      return target.put(...args)
    }
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  const delayed=writeFencedChunk(principal,row!.generation,0,bytes,{...context,env:{...context.env,OBJECTS:objects}}).catch(error=>error)
  await started.promise
  await f.db.prepare('UPDATE storage_generations SET expires_at = 0 WHERE id = ?').bind(row!.generation).run()
  expect(await claimGenerationCleanup(signed.accountId,row!.generation,context)).toBe(true)
  expect(await fenceGeneration(row!.generation,{...context,env:{...context.env,OBJECTS:objects}})).toBe(true)
  const charges=await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')
  expect(charges).toBe(32)
  if(phase==='initializer') await f.db.prepare("UPDATE accounts SET access = 'deleting' WHERE id = ?").bind(signed.accountId).run()
  resume.resolve();expect(await delayed).toBeInstanceOf(Error)
  expect(new Uint8Array(await (await f.objects.get(row!.object_key))!.arrayBuffer())).toEqual(decode(row!.marker))
  expect(await fenceGeneration(row!.generation,context)).toBe(true)
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(charges)
  expect(await f.db.prepare('SELECT state FROM upload_chunks').first('state')).toBe('closed')
  expect(deletes).toBe(0)
})
it('forcedSeedMarkerEtagEqualityRetainsChargesAndUnsafeState',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed),{context}=await direct(f,signed)
  const row=await f.db.prepare('SELECT * FROM upload_chunks WHERE generation = (SELECT generation FROM upload_reservations WHERE upload_id = ?)').bind(item.input.uploadId).first<{generation:string;seed_etag:string}>()
  await f.db.prepare('UPDATE storage_generations SET expires_at = 0').run()
  expect(await claimGenerationCleanup(signed.accountId,row!.generation,context)).toBe(true)
  const objects=new Proxy(context.env.OBJECTS!,{get(target,key){
    if(key==='get')return async (...args:Parameters<typeof target.get>)=>{const result=await target.get(...args);return result ? new Proxy(result,{get(object,field){if(field==='etag')return row!.seed_etag;const value=Reflect.get(object,field);return typeof value==='function'?value.bind(object):value}}):null}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  expect(await fenceGeneration(row!.generation,{...context,env:{...context.env,OBJECTS:objects}})).toBe(false)
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(97)
  expect(await f.db.prepare('SELECT state FROM upload_chunks').first('state')).toBe('unsafe')
})
it.each(['sync.seed.claimed','sync.seed.written','sync.body.authorized','sync.body.written','sync.chunk.ready'])('reconcilesInterruptedUploadAt%sWithoutReissuingInitializer',async stage=>{
  const f=await fixture(),signed=await customer(f),{context,principal}=await direct(f,signed)
  const bytes=randomBytes(33), input={version:1,uploadId:id(),documentId:id(),revisionId:id(),metadataBytes:1000,chunks:[{index:0,cipherBytes:33,cipherDigest:createHash('sha256').update(bytes).digest('base64url')}]}
  expect((await post(f,'sync/uploads',input,signed.headers)).status).toBe(200)
  const generation=await f.db.prepare('SELECT generation FROM upload_chunks').first<string>('generation')
  let initializers=0
  const objects=new Proxy(context.env.OBJECTS!,{get(target,key){if(key==='put')return async(...args:Parameters<typeof target.put>)=>{if((args[2] as {onlyIf?:{etagDoesNotMatch?:string}})?.onlyIf?.etagDoesNotMatch)initializers++;return target.put(...args)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  const scoped={...context,env:{...context.env,OBJECTS:objects}}
  await expect(writeFencedChunk(principal,generation!,0,bytes,{...scoped,checkpoint:point=>{if(point===stage)throw new Error('Synthetic interruption')}})).rejects.toThrow('Synthetic interruption')
  if(stage==='sync.seed.claimed') {
    await expect(writeFencedChunk(principal,generation!,0,bytes,scoped)).rejects.toThrow('SERVICE_UNAVAILABLE')
    expect(initializers).toBe(0)
  } else {
    await writeFencedChunk(principal,generation!,0,bytes,scoped)
    expect(await f.db.prepare('SELECT state FROM upload_chunks').first('state')).toBe('ready')
    expect(initializers).toBe(1)
  }
})
it.each(['sync.marker.before','sync.marker.written','sync.marker.verified','sync.marker.accounted'])('reconcilesInterruptedMarkerAt%sWithoutDoubleRelease',async stage=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed),{context}=await direct(f,signed)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(item.input.uploadId).first<string>('generation')
  await f.db.prepare('UPDATE storage_generations SET expires_at = 0').run()
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(true)
  await expect(fenceGeneration(generation!,{...context,checkpoint:point=>{if(point===stage)throw new Error('Synthetic interruption')}})).rejects.toThrow('Synthetic interruption')
  expect(await fenceGeneration(generation!,context)).toBe(true)
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(32)
})
it('foreignReadyRevisionAndMissingIdHaveTheSameNeutralReadFailure',async()=>{
  const f=await fixture(),first=await customer(f),second=await customer(f,'second'),item=await prepared(f,first)
  const {command}=await import('./testing')
  expect((await post(f,'sync/commits',command([item.descriptor]),first.headers)).status).toBe(200)
  for(const revisionId of [item.descriptor.revisionId,id()]){
    const response=await f.request(`/api/v1/sync/revisions/${revisionId}`,{headers:second.headers})
    expect(response.status).toBe(404);expect(await response.json()).toMatchObject({error:{code:'NOT_FOUND'}})
  }
})
it('scheduledOrphanCleanupWaitsForExpiryAndPreservesImmutableScope',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed,{protected:true})
  await f.runJobs()
  expect(await f.db.prepare('SELECT state FROM upload_chunks').first('state')).toBe('ready')
  f.advance(86_400_000)
  await f.runJobs()
  expect(await f.db.prepare('SELECT state FROM upload_chunks').first('state')).toBe('closed')
  expect(await f.db.prepare('SELECT request_json FROM upload_reservations').first('request_json')).toBe(JSON.stringify(item.input))
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(32)
})
it('finishAuthorityIsRecheckedInsideTheActualD1Batch',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed),{context,principal}=await direct(f,signed)
  await f.db.prepare("UPDATE storage_generations SET state = 'staging'").run()
  let intercepted=false
  const db=new Proxy(f.db,{get(target,key){if(key==='batch')return async(...args:Parameters<typeof target.batch>)=>{if(!intercepted){intercepted=true;await target.prepare("UPDATE accounts SET access = 'blocked' WHERE id = ?").bind(signed.accountId).run()}return target.batch(...args)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  const {finishUpload}=await import('./uploads')
  await expect(finishUpload(principal,item.input.uploadId,{...context,env:{...context.env,DB:db}})).rejects.toThrow('FORBIDDEN')
  expect(await f.db.prepare('SELECT state FROM storage_generations').first('state')).toBe('staging')
})
it('loweredQuotaAndGlobalReservationRejectBeforeAnyObjectWrite',async()=>{
  const f=await fixture(),signed=await customer(f),{context,principal}=await direct(f,signed)
  const {startUpload}=await import('./uploads')
  const bytes=randomBytes(33),input={version:1 as const,uploadId:id(),documentId:id(),revisionId:id(),metadataBytes:1000,chunks:[{index:0,cipherBytes:33,cipherDigest:createHash('sha256').update(bytes).digest('base64url')}]}
  await expect(startUpload(principal,input,{...context,env:{...context.env,STORAGE_CAP_BYTES:'1'}})).rejects.toThrow('QUOTA_EXCEEDED')
  expect((await f.objects.list()).objects).toEqual([])
  expect((await f.db.prepare('SELECT * FROM upload_reservations').all()).results).toEqual([])
  await startUpload(principal,input,context)
  await f.db.prepare('UPDATE accounts SET capacity_bytes = 1').run()
  const generation=await f.db.prepare('SELECT generation FROM upload_chunks').first<string>('generation')
  await expect(writeFencedChunk(principal,generation!,0,bytes,context)).rejects.toThrow('QUOTA_EXCEEDED')
  expect((await f.objects.list()).objects).toEqual([])
})
it('closedLiabilitySurvivesGuardedAccountOwnershipRemoval',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed),{context}=await direct(f,signed)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(item.input.uploadId).first<string>('generation')
  await f.db.prepare('UPDATE storage_generations SET expires_at = 0').run()
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(true)
  expect(await fenceGeneration(generation!,context)).toBe(true)
  await f.db.prepare("UPDATE accounts SET access = 'deleting'").run()
  const {prepareClosedLiabilityTransfer}=await import('./storage'),{runGuardedBatch}=await import('../db/guarded-batch')
  const transfer=prepareClosedLiabilityTransfer(signed.accountId,context)
  // The later deletion owner must add its independent ledger acknowledgment to this SQL guard
  await expect(runGuardedBatch(f.db,{sql:`SELECT (${transfer.guard.sql}) AND 0`,bindings:transfer.guard.bindings},transfer.statements)).rejects.toThrow()
  expect(await f.db.prepare('SELECT account_id FROM upload_chunks').first('account_id')).toBe(signed.accountId)
  await runGuardedBatch(f.db,transfer.guard,transfer.statements)
  await runGuardedBatch(f.db,transfer.guard,transfer.statements)
  expect(await f.db.prepare('SELECT account_id FROM upload_chunks').first('account_id')).toBeNull()
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(32)
  expect(await f.db.prepare('SELECT payload_bytes FROM quota_counters WHERE scope = ?').bind(signed.accountId).first('payload_bytes')).toBe(0)
  expect((await f.objects.list()).objects).toHaveLength(1)
})
it('reservesAndFencesEveryBoundedChunkSlotWithMeasuredD1Statements',async()=>{
  const f=await fixture(),signed=await customer(f),{context,principal}=await direct(f,signed)
  // Larger existing allowances must still support the protocol's maximum reservation shape
  await f.db.prepare('UPDATE accounts SET capacity_bytes=? WHERE id=?').bind(localProjectCapacityBytes,signed.accountId).run()
  const {startUpload}=await import('./uploads'),{measurement}=await import('./testing')
  let maxBatchStatements=0,maxBindings=0,maxSqlBytes=0,statements=0
  const db=new Proxy(f.db,{get(target,key){
    if(key==='batch')return (...args:Parameters<typeof target.batch>)=>{maxBatchStatements=Math.max(maxBatchStatements,args[0].length);return target.batch(...args)}
    if(key==='prepare')return (sql:string)=>{statements++;maxSqlBytes=Math.max(maxSqlBytes,Buffer.byteLength(sql));const statement=target.prepare(sql);return new Proxy(statement,{get(prepared,field){if(field==='bind')return (...values:Parameters<typeof prepared.bind>)=>{maxBindings=Math.max(maxBindings,values.length);return prepared.bind(...values)};const value=Reflect.get(prepared,field);return typeof value==='function'?value.bind(prepared):value}})}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  const scoped={...context,env:{...context.env,DB:db}}
  const input={version:1 as const,uploadId:id(),documentId:id(),revisionId:id(),metadataBytes:1024*1024,chunks:Array.from({length:128},(_,index)=>({index,cipherBytes:4*1024*1024+17,cipherDigest:randomBytes(32).toString('base64url')}))}
  await startUpload(principal,input,scoped)
  expect((await f.objects.list()).objects).toEqual([])
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations').first<string>('generation')
  await f.db.prepare('UPDATE storage_generations SET expires_at = 0').run()
  expect(await claimGenerationCleanup(signed.accountId,generation!,scoped)).toBe(true)
  let calls=0,complete=false
  while(!complete && calls<4){complete=await fenceGeneration(generation!,scoped);calls++}
  expect(complete).toBe(true);expect(calls).toBe(4)
  expect(await f.db.prepare("SELECT COUNT(*) n FROM upload_chunks WHERE state = 'closed'").first('n')).toBe(128)
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(4096)
  expect(maxBindings).toBeLessThanOrEqual(100);expect(maxSqlBytes).toBeLessThan(100000)
  await measurement('bounded-slots',{chunks:128,cleanupCalls:calls,maxBatchStatements,maxBindings,maxSqlBytes,statements,largestRow:await f.db.prepare('SELECT MAX(metadata_bytes) AS size FROM upload_reservations').first('size')})
},30_000)
it('finishRejectsIncompleteChunksAndDeclaredIdentityCannotChange',async()=>{
  const f=await fixture(),signed=await customer(f)
  const bytes=randomBytes(33),input={version:1,uploadId:id(),documentId:id(),revisionId:id(),metadataBytes:1000,chunks:[{index:0,cipherBytes:33,cipherDigest:createHash('sha256').update(bytes).digest('base64url')}]}
  expect((await post(f,'sync/uploads',input,signed.headers)).status).toBe(200)
  expect((await post(f,`sync/uploads/${input.uploadId}/finish`,{version:1},signed.headers)).status).toBe(422)
  for(const change of [{documentId:id()},{revisionId:id()},{metadataBytes:1001},{chunks:[{...input.chunks[0],cipherBytes:34}]}])expect((await post(f,'sync/uploads',{...input,...change},signed.headers)).status).toBe(409)
  expect((await f.request(`/api/v1/sync/uploads/${input.uploadId}/chunks/0`,{method:'PUT',headers:{origin:'http://127.0.0.1','content-type':'application/octet-stream',...signed.headers},body:bytes.subarray(0,32)})).status).toBe(422)
})
it('delayedIdenticalMarkerRetryAfterAnotherCleanerAndRestartCannotDoubleRelease',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed),{context}=await direct(f,signed)
  const row=await f.db.prepare('SELECT generation,object_key,marker FROM upload_chunks').first<{generation:string;object_key:string;marker:string}>()
  await f.db.prepare('UPDATE storage_generations SET expires_at = 0').run()
  expect(await claimGenerationCleanup(signed.accountId,row!.generation,context)).toBe(true)
  const started=deferred(),resume=deferred()
  const objects=new Proxy(context.env.OBJECTS!,{get(target,key){if(key==='put')return async(...args:Parameters<typeof target.put>)=>{started.resolve();await resume.promise;return target.put(...args)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  const delayed=fenceGeneration(row!.generation,{...context,env:{...context.env,OBJECTS:objects}})
  await started.promise
  expect(await fenceGeneration(row!.generation,(await direct(f,signed)).context)).toBe(true)
  resume.resolve();expect(await delayed).toBe(true)
  expect(new Uint8Array(await (await f.objects.get(row!.object_key))!.arrayBuffer())).toEqual(decode(row!.marker))
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(32)
  expect(item.bytes.length).toBe(33)
})
it('metadataOnlyReplacementCannotBeClassifiedAsAContentRemovalFence',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed),{context}=await direct(f,signed)
  const row=await f.db.prepare('SELECT generation FROM upload_chunks').first<{generation:string}>()
  await f.db.prepare('UPDATE storage_generations SET expires_at = 0').run()
  expect(await claimGenerationCleanup(signed.accountId,row!.generation,context)).toBe(true)
  const objects=new Proxy(context.env.OBJECTS!,{get(target,key){if(key==='put')return (objectKey:string)=>target.put(objectKey,item.bytes,{customMetadata:{synthetic:'metadata-only'}});const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  expect(await fenceGeneration(row!.generation,{...context,env:{...context.env,OBJECTS:objects}})).toBe(false)
  expect(await fenceGeneration(row!.generation,context)).toBe(false)
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(97)
})
it.each(['initializer','body','marker','accounting'] as const)('reconcilesActualLost%sBindingResponseWithFreshContext',async phase=>{
  const f=await fixture(),signed=await customer(f),{context,principal}=await direct(f,signed)
  const bytes=randomBytes(33),input={version:1,uploadId:id(),documentId:id(),revisionId:id(),metadataBytes:1000,chunks:[{index:0,cipherBytes:33,cipherDigest:createHash('sha256').update(bytes).digest('base64url')}]}
  expect((await post(f,'sync/uploads',input,signed.headers)).status).toBe(200)
  const generation=await f.db.prepare('SELECT generation FROM upload_chunks').first<string>('generation')
  if(phase==='marker'||phase==='accounting'){
    await writeFencedChunk(principal,generation!,0,bytes,context)
    await f.db.prepare('UPDATE storage_generations SET expires_at = 0').run()
    expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(true)
  }
  let lost=false
  const objects=new Proxy(context.env.OBJECTS!,{get(target,key){if(key==='put')return async(...args:Parameters<typeof target.put>)=>{
    const result=await target.put(...args),options=args[2] as {onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}|undefined
    if(!lost&&((phase==='initializer'&&options?.onlyIf?.etagDoesNotMatch)||(phase==='body'&&options?.onlyIf?.etagMatches)||(phase==='marker'&&!options))){lost=true;throw new Error('Synthetic lost binding response')}
    return result
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  const db=new Proxy(f.db,{get(target,key){if(key==='batch')return async(...args:Parameters<typeof target.batch>)=>{const result=await target.batch(...args);if(phase==='accounting'&&!lost){lost=true;throw new Error('Synthetic lost binding response')}return result};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  const scoped={...context,env:{...context.env,DB:db,OBJECTS:objects}}
  if(phase==='initializer'||phase==='body'){
    await expect(writeFencedChunk(principal,generation!,0,bytes,scoped)).rejects.toThrow('Synthetic lost binding response')
    await writeFencedChunk(principal,generation!,0,bytes,(await direct(f,signed)).context)
    expect(await f.db.prepare('SELECT state FROM upload_chunks').first('state')).toBe('ready')
  }else{
    await expect(fenceGeneration(generation!,scoped)).rejects.toThrow('Synthetic lost binding response')
    expect(await fenceGeneration(generation!,(await direct(f,signed)).context)).toBe(true)
    expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(32)
  }
  expect(lost).toBe(true)
})
it('concurrentUnsafeFindingPreventsAnotherCleanerFromReleasingCharges',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed),{context}=await direct(f,signed)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(item.input.uploadId).first<string>('generation')
  await f.db.prepare('UPDATE storage_generations SET expires_at = 0').run()
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(true)
  let intercepted=false
  const db=new Proxy(f.db,{get(target,key){if(key==='batch')return async(...args:Parameters<typeof target.batch>)=>{if(!intercepted){intercepted=true;await target.prepare("UPDATE storage_generations SET state = 'unsafe' WHERE id = ?").bind(generation).run()}return target.batch(...args)};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  await expect(fenceGeneration(generation!,{...context,env:{...context.env,DB:db}})).rejects.toThrow('transaction_guard_passed')
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope = 'global'").first('payload_bytes')).toBe(97)
})
it.each([1,2,3,4])('lostD1UploadTransitionResponseAtBatch%sPreservesOneShotAuthority',async batchToLose=>{
  const f=await fixture(),signed=await customer(f),{context,principal}=await direct(f,signed)
  const bytes=randomBytes(33),input={version:1,uploadId:id(),documentId:id(),revisionId:id(),metadataBytes:1000,chunks:[{index:0,cipherBytes:33,cipherDigest:createHash('sha256').update(bytes).digest('base64url')}]}
  expect((await post(f,'sync/uploads',input,signed.headers)).status).toBe(200)
  const generation=await f.db.prepare('SELECT generation FROM upload_chunks').first<string>('generation')
  let batches=0
  const db=new Proxy(f.db,{get(target,key){if(key==='batch')return async(...args:Parameters<typeof target.batch>)=>{const result=await target.batch(...args);if(++batches===batchToLose)throw new Error('Synthetic lost D1 response');return result};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  await expect(writeFencedChunk(principal,generation!,0,bytes,{...context,env:{...context.env,DB:db}})).rejects.toThrow('SERVICE_UNAVAILABLE')
  const fresh=(await direct(f,signed)).context
  if(batchToLose===1){
    await expect(writeFencedChunk(principal,generation!,0,bytes,fresh)).rejects.toThrow('SERVICE_UNAVAILABLE')
    expect((await f.objects.list()).objects).toEqual([])
  }else{
    await writeFencedChunk(principal,generation!,0,bytes,fresh)
    expect(await f.db.prepare('SELECT state FROM upload_chunks').first('state')).toBe('ready')
    expect((await f.objects.list()).objects).toHaveLength(1)
  }
})
