import { expect, it } from 'vitest'
import { CommitRequestSchema, CommitReceiptSchema, ChangePageSchema } from '../../src/account/protocol'
const id = 'AAAAAAAAAAAAAAAAAAAAAA'
it('requiresPublicationEpochOnReceiptsAndDistinguishesOmissionFromZero', () => {
  const input = { version: 1, mutationId: id, revisions: [], expected: [{ documentId: id, revisionId: null }], heads: [{ documentId: id, revisionId: id }] }
  expect(CommitRequestSchema.safeParse({ ...input, expectedPublicationEpoch: 0 }).success).toBe(true)
  expect(CommitReceiptSchema.safeParse({ version: 1, mutationId: id, sequence: 1, heads: input.heads }).success).toBe(false)
  expect(ChangePageSchema.safeParse({ version: 1, mode: 'initial', watermark: 1, cursor: '', hasMore: false, groups: [] }).success).toBe(false)
})
it('rejectsEpochGuardsWithoutPublicationAndUnsafeCounters', () => {
  const head = { documentId: id, revisionId: id }
  const input = { version: 1, mutationId: id, revisions: [], expected: [head], heads: [head] }
  for (const expectedPublicationEpoch of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(CommitRequestSchema.safeParse({ ...input, expectedPublicationEpoch }).success).toBe(false)
  expect(CommitRequestSchema.safeParse({ ...input, expected: [], heads: [], expectedPublicationEpoch: 0 }).success).toBe(false)
  expect(CommitReceiptSchema.safeParse({ version: 1, mutationId: id, sequence: 1, publicationEpoch: 0, heads: [] }).success).toBe(true)
})

import { fixture, customer, prepared, post, command, direct, measurement, measuredDatabase, id as freshId } from './testing'
import { claimGenerationCleanup, fenceGeneration } from './storage'

it('publishesCompleteClosureOrNothing', async () => {
  const f = await fixture(), signed = await customer(f)
  const first = await prepared(f,signed), second = await prepared(f,signed,{documentId:first.descriptor.documentId})
  const results = await Promise.all([post(f,'sync/commits',command([first.descriptor]),signed.headers),post(f,'sync/commits',command([second.descriptor]),signed.headers)])
  expect(results.map(r=>r.status).sort()).toEqual([200,409])
  expect((await f.db.prepare('SELECT * FROM sync_documents').all()).results).toHaveLength(1)
  expect((await f.db.prepare('SELECT * FROM sync_revisions').all()).results).toHaveLength(1)
  const loser = results[0].status === 409 ? first : second
  expect(await f.db.prepare('SELECT head FROM sync_documents WHERE head = ?').bind(loser.descriptor.revisionId).first()).toBeNull()
})
it('retainsOlderExactDependenciesWhenTheOwningDocumentHasANewerHead', async () => {
  const f = await fixture(), signed = await customer(f)
  const older = await prepared(f,signed)
  expect((await post(f,'sync/commits',command([older.descriptor],[],[]),signed.headers)).status).toBe(200)
  const newer = await prepared(f,signed,{documentId:older.descriptor.documentId,parents:[older.descriptor.revisionId]})
  expect((await post(f,'sync/commits',command([newer.descriptor]),signed.headers)).status).toBe(200)
  const child = await prepared(f,signed,{dependencies:[{documentId:older.descriptor.documentId,revisionId:older.descriptor.revisionId}]})
  expect((await post(f,'sync/commits',command([child.descriptor]),signed.headers)).status).toBe(200)
  const oldGeneration = await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(older.input.uploadId).first<string>('generation')
  const {context} = await direct(f,signed,1_800_000_000_000 + 86_400_001)
  expect(await claimGenerationCleanup(signed.accountId,oldGeneration!,context)).toBe(false)
  expect((await f.request(`/api/v1/sync/revisions/${older.descriptor.revisionId}/chunks/0`,{headers:signed.headers})).status).toBe(200)
})
it('archivesLosingBranchesAndHeadOnlyPublicationKeepsSameDocumentParents', async () => {
  const f=await fixture(), signed=await customer(f)
  const first=await prepared(f,signed)
  expect((await post(f,'sync/commits',command([first.descriptor]),signed.headers)).status).toBe(200)
  const branch=await prepared(f,signed,{documentId:first.descriptor.documentId,parents:[first.descriptor.revisionId]})
  const stage=command([branch.descriptor],[],[])
  const staged=await post(f,'sync/commits',stage,signed.headers)
  expect(await staged.json()).toMatchObject({sequence:2,publicationEpoch:1,heads:[]})
  expect((await post(f,'sync/commits',stage,signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT head FROM sync_documents').first('head')).toBe(first.descriptor.revisionId)
  const publish=command([],[{documentId:branch.descriptor.documentId,revisionId:branch.descriptor.revisionId}],[{documentId:first.descriptor.documentId,revisionId:first.descriptor.revisionId}])
  expect(await (await post(f,'sync/commits',publish,signed.headers)).json()).toMatchObject({sequence:3,publicationEpoch:2})
  expect((await post(f,'sync/commits',publish,signed.headers)).status).toBe(200)
})
it('disjointOrdinaryCommandsShareTheUnchangedRootAndRejectStaleBulkEpoch', async () => {
  const f=await fixture(), signed=await customer(f)
  const root=await prepared(f,signed), rootHead={documentId:root.descriptor.documentId,revisionId:root.descriptor.revisionId}
  expect((await post(f,'sync/commits',command([root.descriptor]),signed.headers)).status).toBe(200)
  const a=await prepared(f,signed), b=await prepared(f,signed)
  const make=(r: typeof a)=>command([r.descriptor],[rootHead,{documentId:r.descriptor.documentId,revisionId:r.descriptor.revisionId}],[rootHead,{documentId:r.descriptor.documentId,revisionId:null}])
  expect((await Promise.all([post(f,'sync/commits',make(a),signed.headers),post(f,'sync/commits',make(b),signed.headers)])).map(r=>r.status)).toEqual([200,200])
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM head_history WHERE document_id = ?').bind(rootHead.documentId).first('n')).toBe(1)
  expect((await post(f,'sync/commits',{...command([], [rootHead],[rootHead]),expectedPublicationEpoch:1},signed.headers)).status).toBe(409)
  expect(await (await post(f,'sync/commits',command([],[rootHead],[rootHead]),signed.headers)).json()).toMatchObject({sequence:4,publicationEpoch:3})
})
it('bulkEpochRejectsActualHeadABAWhileExactAcceptedReplayKeepsItsReceipt', async () => {
  const f=await fixture(), signed=await customer(f)
  const a=await prepared(f,signed), aHead={documentId:a.descriptor.documentId,revisionId:a.descriptor.revisionId}
  const original={...command([a.descriptor]),expectedPublicationEpoch:0}
  const receipt=await (await post(f,'sync/commits',original,signed.headers)).json()
  const b=await prepared(f,signed,{documentId:a.descriptor.documentId,parents:[a.descriptor.revisionId]})
  const bHead={documentId:b.descriptor.documentId,revisionId:b.descriptor.revisionId}
  expect((await post(f,'sync/commits',command([b.descriptor],[bHead],[aHead]),signed.headers)).status).toBe(200)
  expect((await post(f,'sync/commits',command([],[aHead],[bHead]),signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT head FROM sync_documents').first('head')).toBe(aHead.revisionId)
  expect((await post(f,'sync/commits',{...command([],[aHead],[aHead]),expectedPublicationEpoch:1},signed.headers)).status).toBe(409)
  expect(await (await post(f,'sync/commits',original,signed.headers)).json()).toEqual(receipt)
  expect(await f.db.prepare('SELECT publication_epoch FROM account_sequences').first('publication_epoch')).toBe(3)
})
it('cleanupWinningBeforeClosureMakesPublicationFailAndRevivalKeepsExactIdentity', async () => {
  const f=await fixture(), signed=await customer(f)
  const item=await prepared(f,signed,{protected:true})
  const stage=command([item.descriptor],[],[])
  expect((await post(f,'sync/commits',stage,signed.headers)).status).toBe(200)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(item.input.uploadId).first<string>('generation')
  const {context}=await direct(f,signed,1_800_000_000_000+86_400_001)
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(true)
  expect(await fenceGeneration(generation!,context)).toBe(true)
  const publish=command([],[{documentId:item.descriptor.documentId,revisionId:item.descriptor.revisionId}])
  expect((await post(f,'sync/commits',publish,signed.headers)).status).toBe(422)
  expect((await post(f,'sync/uploads',{...item.input,metadataBytes:item.input.metadataBytes+1},signed.headers)).status).toBe(409)
  expect((await post(f,'sync/uploads',item.input,signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(item.input.uploadId).first('generation')).not.toBe(generation)
  expect((await f.request(`/api/v1/sync/uploads/${item.input.uploadId}/chunks/0`,{method:'PUT',headers:{origin:'http://127.0.0.1','content-type':'application/octet-stream',...signed.headers},body:item.bytes})).status).toBe(200)
  expect((await post(f,`sync/uploads/${item.input.uploadId}/finish`,{version:1},signed.headers)).status).toBe(200)
  expect((await post(f,'sync/commits',publish,signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT head FROM sync_documents').first('head')).toBe(item.descriptor.revisionId)
  const restored=await f.request(`/api/v1/sync/revisions/${item.descriptor.revisionId}/chunks/0`,{headers:signed.headers})
  expect(restored.status).toBe(200)
  expect(new Uint8Array(await restored.arrayBuffer())).toEqual(new Uint8Array(item.bytes))

})
it('historicalInitialScanKeepsItsCoherentWatermarkWhileWritesContinue',async()=>{
  const f=await fixture(),signed=await customer(f)
  const items=[]
  for(let index=0;index<33;index++)items.push(await prepared(f,signed))
  expect((await post(f,'sync/commits',command(items.slice(0,32).map(i=>i.descriptor)),signed.headers)).status).toBe(200)
  expect((await post(f,'sync/commits',command([items[32].descriptor]),signed.headers)).status).toBe(200)
  const first=await (await f.request('/api/v1/sync/changes?limit=32',{headers:signed.headers})).json() as import('../../src/account/protocol').ChangePage
  expect(first).toMatchObject({watermark:2,publicationEpoch:2,mode:'initial',hasMore:true})
  const replacement=await prepared(f,signed,{documentId:items[32].descriptor.documentId,parents:[items[32].descriptor.revisionId]})
  expect((await post(f,'sync/commits',command([replacement.descriptor],undefined,[{documentId:replacement.descriptor.documentId,revisionId:items[32].descriptor.revisionId}]),signed.headers)).status).toBe(200)
  const added=await prepared(f,signed)
  expect((await post(f,'sync/commits',command([added.descriptor]),signed.headers)).status).toBe(200)
  const second=await (await f.request(`/api/v1/sync/changes?limit=32&cursor=${encodeURIComponent(first.cursor)}`,{headers:signed.headers})).json() as import('../../src/account/protocol').ChangePage
  expect(second).toMatchObject({watermark:2,publicationEpoch:2,mode:'initial',hasMore:false})
  expect(second.groups.flatMap(g=>g.heads)).toEqual([{documentId:items[32].descriptor.documentId,revisionId:items[32].descriptor.revisionId}])
  const incremental=await (await f.request(`/api/v1/sync/changes?limit=32&cursor=${encodeURIComponent(second.cursor)}`,{headers:signed.headers})).json() as import('../../src/account/protocol').ChangePage
  expect(incremental).toMatchObject({watermark:4,publicationEpoch:4,mode:'incremental'})
  expect(incremental.groups.map(g=>g.sequence)).toEqual([3,4])
  expect((await f.request(`/api/v1/sync/changes?cursor=${first.cursor.slice(0,-1)}x`,{headers:signed.headers})).status).toBe(409)
  f.advance(30*60*1000)
  expect((await f.request(`/api/v1/sync/changes?cursor=${first.cursor}`,{headers:signed.headers})).status).toBe(409)
},20_000)
it('rejectsMissingAndCyclicDependenciesWithoutPartialPublication',async()=>{
  const f=await fixture(),signed=await customer(f)
  const aId=freshId(), bId=freshId(), aDoc=freshId(), bDoc=freshId()
  const a=await prepared(f,signed,{documentId:aDoc,revisionId:aId,dependencies:[{documentId:bDoc,revisionId:bId}]})
  expect((await post(f,'sync/commits',command([a.descriptor]),signed.headers)).status).toBe(404)
  const b=await prepared(f,signed,{documentId:bDoc,revisionId:bId,dependencies:[{documentId:aDoc,revisionId:aId}]})
  expect((await post(f,'sync/commits',command([a.descriptor,b.descriptor]),signed.headers)).status).toBe(422)
  expect((await f.db.prepare('SELECT * FROM sync_documents').all()).results).toEqual([])
})
it('smallPageTargetsKeepWholeHeadOnlyCommandsAndAdvanceExactlyOnce',async()=>{
  const f=await fixture(),signed=await customer(f)
  const initial=await (await f.request('/api/v1/sync/changes?limit=1',{headers:signed.headers})).json() as import('../../src/account/protocol').ChangePage
  const items=[]
  for(let index=0;index<32;index++)items.push(await prepared(f,signed))
  expect((await post(f,'sync/commits',command(items.map(i=>i.descriptor),[],[]),signed.headers)).status).toBe(200)
  expect((await post(f,'sync/commits',command([],items.map(i=>({documentId:i.descriptor.documentId,revisionId:i.descriptor.revisionId}))),signed.headers)).status).toBe(200)
  for(const limit of [1,31]){
    const page=await (await f.request(`/api/v1/sync/changes?limit=${limit}&cursor=${initial.cursor}`,{headers:signed.headers})).json() as import('../../src/account/protocol').ChangePage
    expect(page.groups).toHaveLength(1);expect(page.groups[0].revisions).toHaveLength(32);expect(page.hasMore).toBe(true)
    const next=await (await f.request(`/api/v1/sync/changes?limit=${limit}&cursor=${page.cursor}`,{headers:signed.headers})).json() as import('../../src/account/protocol').ChangePage
    expect(next.groups).toHaveLength(1);expect(next.groups[0].heads).toHaveLength(32);expect(next.groups[0].revisions).toHaveLength(0);expect(next.groups[0].sequence).toBe(2)
    const end=await (await f.request(`/api/v1/sync/changes?limit=${limit}&cursor=${next.cursor}`,{headers:signed.headers})).json() as import('../../src/account/protocol').ChangePage
    expect(end.groups).toEqual([]);expect(end.hasMore).toBe(false)
  }
  const defaults=await (await f.request(`/api/v1/sync/changes?cursor=${initial.cursor}`,{headers:signed.headers})).json() as import('../../src/account/protocol').ChangePage
  expect(defaults.groups.map(group=>group.sequence)).toEqual([1,2]);expect(defaults.hasMore).toBe(false)
  for(const limit of [0,101,1.5])expect((await f.request(`/api/v1/sync/changes?limit=${limit}`,{headers:signed.headers})).status).toBe(400)
  const one=await (await f.request('/api/v1/sync/changes?limit=1',{headers:signed.headers})).json() as import('../../src/account/protocol').ChangePage
  expect(one.groups.flatMap(g=>g.heads)).toHaveLength(1)
},20_000)
it('boundedDurableClosureResumesBeyondDirectDependencyLimitAndRetainsEveryExactGeneration',async()=>{
  const f=await fixture(),signed=await customer(f)
  const leaves=[]
  const started=performance.now()
  for(let index=0;index<257;index++)leaves.push(await prepared(f,signed))
  for(let index=0;index<leaves.length;index+=32)expect((await post(f,'sync/commits',command(leaves.slice(index,index+32).map(i=>i.descriptor),[],[]),signed.headers)).status).toBe(200)
  const pages=[]
  for(let index=0;index<leaves.length;index+=128) {
    const page=await prepared(f,signed,{dependencies:leaves.slice(index,index+128).map(i=>({documentId:i.descriptor.documentId,revisionId:i.descriptor.revisionId}))})
    // Registration validates its full closure too, so the exact staging identity must resume
    const stage=command([page.descriptor],[],[])
    let response=await post(f,'sync/commits',stage,signed.headers)
    for(let retry=0;response.status===503 && retry<4;retry++)response=await post(f,'sync/commits',stage,signed.headers)
    expect(response.status).toBe(200);pages.push(page)
  }
  const root=await prepared(f,signed,{protected:true,dependencies:pages.map(i=>({documentId:i.descriptor.documentId,revisionId:i.descriptor.revisionId}))})
  const publish=command([root.descriptor])
  const measured=measuredDatabase(f.db),invocations:object[]=[]
  const directContext=await direct(f,signed)
  const {commitRevisions}=await import('./commit')
  const invoke=async()=>{measured.reset();const startedCall=performance.now();try{await commitRevisions(directContext.principal,publish,{...directContext.context,env:{...directContext.context.env,DB:measured.db}});return {status:200}}catch(error){if(error instanceof Error && error.message==='SERVICE_UNAVAILABLE')return {status:503};throw error}finally{invocations.push({...measured.values,elapsedMs:performance.now()-startedCall});expect(measured.values.queries).toBeLessThan(1000)}}
  let response=await invoke(),calls=1
  expect(response.status).toBe(503)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(leaves[256].input.uploadId).first<string>('generation')
  const {context}=await direct(f,signed,1_800_000_000_000+86_400_001)
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(false)
  while(response.status===503 && calls<12){response=await invoke();calls++}
  expect(response.status).toBe(200)
  expect(await f.db.prepare('SELECT COUNT(*) AS n FROM publication_pins WHERE mutation_id = ? AND done = 1').bind(publish.mutationId).first('n')).toBe(261)
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(false)
  await measurement('graph',{revisions:261,calls,invocations,elapsedMs:Math.round(performance.now()-started),quota:(await f.db.prepare('SELECT * FROM quota_counters ORDER BY scope').all()).results,transactions:f.events().filter(e=>e.operation==='sync'&&e.stage==='transaction')})
  const dense=[]
  for(let index=0;index<32;index++)dense.push((await prepared(f,signed,{dependencies:leaves.slice(0,256).map(i=>({documentId:i.descriptor.documentId,revisionId:i.descriptor.revisionId}))})).descriptor)
  const denseCommand=command(dense,leaves.slice(0,32).map(i=>({documentId:i.descriptor.documentId,revisionId:i.descriptor.revisionId})))
  const requestBytes=Buffer.byteLength(JSON.stringify(denseCommand))
  expect(requestBytes).toBeLessThan(1024*1024)
  const denseInvocations:object[]=[]
  let denseReceipt:import('../../src/account/protocol').CommitReceipt|undefined
  for(let call=0;call<9&&!denseReceipt;call++){
    measured.reset()
    try{denseReceipt=await commitRevisions(directContext.principal,denseCommand,{...directContext.context,env:{...directContext.context.env,DB:measured.db}})}catch(error){if(!(error instanceof Error)||error.message!=='SERVICE_UNAVAILABLE')throw error}
    expect(measured.values.queries+12).toBeLessThan(900)
    denseInvocations.push({...measured.values,routeQueries:measured.values.queries+12})
  }
  expect(denseReceipt?.heads).toHaveLength(32)
  const largestReceipt=await f.db.prepare('SELECT MAX(metadata_bytes) AS size FROM mutation_receipts').first<number>('size')
  expect(largestReceipt).toBeLessThan(2_000_000)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM sync_dependencies WHERE revision_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(dense.map(r=>r.revisionId))).first('n')).toBe(8192)
  await measurement('dense-dependencies',{requestBytes,revisions:32,dependencies:8192,invocations:denseInvocations,largestReceipt})
},60_000)
it('realD1FailureRollsBackHeadsRevisionsSequenceAndCounters',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed)
  const publish=command([item.descriptor])
  await f.db.exec("CREATE TRIGGER reject_head BEFORE INSERT ON sync_documents BEGIN SELECT RAISE(ABORT,'synthetic publish failure'); END")
  expect((await post(f,'sync/commits',publish,signed.headers)).status).toBe(503)
  expect((await f.db.prepare('SELECT * FROM sync_revisions').all()).results).toEqual([])
  expect((await f.db.prepare('SELECT * FROM sync_documents').all()).results).toEqual([])
  expect((await f.db.prepare('SELECT * FROM mutation_receipts').all()).results).toEqual([])
  expect(await f.db.prepare('SELECT sequence FROM account_sequences').first('sequence')).toBe(0)
  await f.db.exec('DROP TRIGGER reject_head')
  expect((await post(f,'sync/commits',publish,signed.headers)).status).toBe(200)
})
it('metadataCountersMatchIndependentEncodedRowsAfterRetryCleanupAndExpiredWork',async()=>{
  const f=await fixture(),signed=await customer(f),item=await prepared(f,signed)
  expect((await post(f,'sync/commits',command([item.descriptor],[],[]),signed.headers)).status).toBe(200)
  const {context}=await direct(f,signed,1_800_000_000_000+86_400_001)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(item.input.uploadId).first<string>('generation')
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(true)
  expect(await fenceGeneration(generation!,context)).toBe(true)
  const tables=['account_sequences','upload_reservations','storage_generations','upload_chunks','sync_documents','sync_revisions','sync_dependencies','mutation_receipts','head_history','scan_leases','publication_work','publication_pins','publication_progress','publication_certificates','publication_borrows']
  let bytes=0,rows=0,largest=0
  for(const table of tables)for(const row of (await f.db.prepare(`SELECT * FROM ${table}`).all()).results){
    const size=Buffer.byteLength(JSON.stringify(Object.entries(row).filter(([key])=>key!=='metadata_bytes').map(([,value])=>value)))
    expect(row.metadata_bytes).toBe(size);bytes+=size;rows++;largest=Math.max(largest,size)
  }
  let journalBytes=0,journalRows=0
  const globalTables=['service_jobs','deletion_status','revocation_intents','service_audit','operators','admin_access_sessions','admin_sessions','admin_confirmations','admin_bootstrap_intents','admin_security_audit','admin_actions','admin_previews','admin_audit','admin_invitations','service_settings','admin_revocations']
  for(const table of globalTables)for(const row of (await f.db.prepare(`SELECT * FROM ${table}`).all()).results){
    // Appended admin revisions have a separate charge and are absent from the original generated column
    const size=Buffer.byteLength(JSON.stringify(Object.entries(row).filter(([key])=>key!=='metadata_bytes'&&(table!=='service_jobs'||key!=='admin_revision')).map(([,value])=>value)))
    expect(row.metadata_bytes).toBe(size);journalBytes+=size;journalRows++
    if(table==='service_jobs'){
      expect(row.admin_revision).toEqual(expect.any(Number))
      journalBytes+=Buffer.byteLength(JSON.stringify([row.admin_revision]))
    }
  }
  // Recovery adds authoritative non-sync rows and permanent control/quota envelopes globally
  let serviceBytes=0,serviceRows=0
  for(const table of ['accounts','credentials','devices','account_security_notices','email_jobs','email_attempts','email_audit'])for(const row of (await f.db.prepare(`SELECT * FROM ${table}`).all()).results){
    serviceBytes+=Buffer.byteLength(JSON.stringify(Object.entries(row).filter(([key])=>table!=='email_jobs'||key!=='admin_revision').map(([,value])=>value)));serviceRows++
    if(table==='email_jobs'){
      expect(row.admin_revision).toEqual(expect.any(Number))
      serviceBytes+=Buffer.byteLength(JSON.stringify([row.admin_revision]))
    }
  }
  const quotaIdentities=await f.db.prepare('SELECT COUNT(*) n FROM quota_counters').first<number>('n')
  const fixedServiceReservation=16384,quotaIdentityReservation=256
  for(const scope of ['global',signed.accountId])expect(await f.db.prepare('SELECT metadata_bytes,metadata_rows,edges,payload_bytes,reserved_metadata FROM quota_counters WHERE scope = ?').bind(scope).first()).toEqual({metadata_bytes:bytes+(scope==='global'?journalBytes+serviceBytes:0),metadata_rows:rows+(scope==='global'?journalRows+serviceRows:0),edges:0,payload_bytes:32,reserved_metadata:scope==='global'?fixedServiceReservation+quotaIdentities!*quotaIdentityReservation:0})
  expect(largest).toBeLessThan(2_000_000)
  await measurement('metadata',{bytes,rows,largest})
})
it('expiredUnacceptedWorkReconcilesOutcomeWhileAcceptedPinsNeverExpire',async()=>{
  const f=await fixture(),signed=await customer(f),a=await prepared(f,signed),b=await prepared(f,signed,{documentId:a.descriptor.documentId})
  expect((await post(f,'sync/commits',command([a.descriptor]),signed.headers)).status).toBe(200)
  expect((await post(f,'sync/commits',command([b.descriptor]),signed.headers)).status).toBe(409)
  const {context}=await direct(f,signed,1_800_000_000_000+86_400_001)
  const {reconcileExpiredPublicationWork}=await import('./commit')
  expect(await reconcileExpiredPublicationWork(context)).toBe(1)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(a.input.uploadId).first<string>('generation')
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(false)
  expect(await f.db.prepare("SELECT COUNT(*) n FROM publication_work WHERE state = 'accepted'").first('n')).toBe(1)
})
it('measuresWholeMaximumDescriptorAndHeadCommandBeforeChoosingTheWorkBudget',async()=>{
  const f=await fixture(),signed=await customer(f),parents=[],revisions=[],heads=[]
  for(let index=0;index<32;index++){
    const a=await prepared(f,signed),b=await prepared(f,signed,{documentId:a.descriptor.documentId})
    parents.push(a.descriptor,b.descriptor)
    const next=await prepared(f,signed,{documentId:a.descriptor.documentId,parents:[a.descriptor.revisionId,b.descriptor.revisionId]})
    revisions.push(next.descriptor);heads.push({documentId:a.descriptor.documentId,revisionId:a.descriptor.revisionId})
  }
  for(let index=0;index<parents.length;index+=32)expect((await post(f,'sync/commits',command(parents.slice(index,index+32),[],[]),signed.headers)).status).toBe(200)
  const measured=measuredDatabase(f.db),{context,principal}=await direct(f,signed),{commitRevisions}=await import('./commit')
  const started=performance.now()
  const request=command(revisions,heads),invocations:object[]=[]
  let receipt:import('../../src/account/protocol').CommitReceipt|undefined
  for(let call=0;call<3&&!receipt;call++){
    measured.reset()
    try{receipt=await commitRevisions(principal,request,{...context,env:{...context.env,DB:measured.db}})}catch(error){if(!(error instanceof Error)||error.message!=='SERVICE_UNAVAILABLE')throw error}
    // Customer authority, service admission and work reservation each add four statements
    const routeQueries=measured.values.queries+12
    expect(routeQueries).toBeLessThan(900)
    expect(measured.values.maxBindings).toBeLessThanOrEqual(100)
    invocations.push({...measured.values,routeQueries})
  }
  expect(receipt?.heads).toHaveLength(32)
  await measurement('max-command',{invocations,authQueriesFromProducer:4,admissionQueriesFromProducer:8,elapsedMs:performance.now()-started,largestRow:await f.db.prepare('SELECT MAX(metadata_bytes) AS size FROM mutation_receipts').first('size')})
},30_000)
it('concurrentSameCommandRetainedPromotionCannotBeOverwrittenByAStaleFrontierRead',async()=>{
  const f=await fixture(),signed=await customer(f)
  const leaf=await prepared(f,signed,{revisionId:Buffer.alloc(16,2).toString('base64url')})
  expect((await post(f,'sync/commits',command([leaf.descriptor],[],[]),signed.headers)).status).toBe(200)
  const archived=await prepared(f,signed,{revisionId:Buffer.alloc(16,0).toString('base64url'),dependencies:[{documentId:leaf.descriptor.documentId,revisionId:leaf.descriptor.revisionId}]})
  const root=await prepared(f,signed,{revisionId:Buffer.alloc(16,1).toString('base64url'),dependencies:[{documentId:archived.descriptor.documentId,revisionId:archived.descriptor.revisionId}]})
  const input=command([archived.descriptor,root.descriptor],[{documentId:root.descriptor.documentId,revisionId:root.descriptor.revisionId}])
  const {context,principal}=await direct(f,signed),{commitRevisions}=await import('./commit')
  let batches=0,otherSteps=0
  const db=new Proxy(f.db,{get(target,key){if(key==='batch')return async(...args:Parameters<typeof target.batch>)=>{
    if(++batches===2){
      // The second real worker expands the head while this worker holds the old archive flag
      await expect(commitRevisions(principal,input,{...context,checkpoint:stage=>{if(stage==='sync.closure.step'&&++otherSteps===2)throw new Error('Pause other worker')}})).rejects.toThrow('Pause other worker')
      expect(await target.prepare('SELECT retained FROM publication_pins WHERE mutation_id = ? AND revision_id = ?').bind(input.mutationId,archived.descriptor.revisionId).first('retained')).toBe(1)
    }
    return target.batch(...args)
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
  await commitRevisions(principal,input,{...context,env:{...context.env,DB:db}})
  expect(await f.db.prepare('SELECT retained FROM publication_pins WHERE mutation_id = ? AND revision_id = ?').bind(input.mutationId,leaf.descriptor.revisionId).first('retained')).toBe(1)
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(leaf.input.uploadId).first<string>('generation')
  expect(await claimGenerationCleanup(signed.accountId,generation!,{...context,now:()=>1_800_000_000_000+86_400_001})).toBe(false)
})
it('interruptedClosureKeepsItsBarrierAndExactMutationResumesAfterRestart',async()=>{
  const f=await fixture(),signed=await customer(f),leaf=await prepared(f,signed)
  expect((await post(f,'sync/commits',command([leaf.descriptor],[],[]),signed.headers)).status).toBe(200)
  const root=await prepared(f,signed,{dependencies:[{documentId:leaf.descriptor.documentId,revisionId:leaf.descriptor.revisionId}]})
  const input=command([root.descriptor])
  f.failNext('sync.closure.step')
  expect((await post(f,'sync/commits',input,signed.headers)).status).toBe(503)
  expect(await (await f.request(`/api/v1/sync/mutations/${input.mutationId}`,{headers:signed.headers})).json()).toEqual({unknown:true})
  const generation=await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(leaf.input.uploadId).first<string>('generation')
  const {context}=await direct(f,signed,1_800_000_000_000+86_400_001)
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(false)
  expect((await post(f,'sync/commits',input,signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_work WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(1)
  expect(await claimGenerationCleanup(signed.accountId,generation!,context)).toBe(false)
})
it('continuationBindsDurableActualTransitionsAndDoesNotCountReplayOrPromotion', async () => {
  const f = await fixture(), signed = await customer(f), leaves = []
  for (let index = 0; index < 50; index++) leaves.push((await prepared(f, signed)).descriptor)
  for (let index = 0; index < leaves.length; index += 32) expect((await post(f, 'sync/commits', command(leaves.slice(index, index + 32), [], []), signed.headers)).status).toBe(200)
  const root = await prepared(f, signed, { dependencies: leaves.map(({ documentId, revisionId }) => ({ documentId, revisionId })) })
  const input = command([root.descriptor]), response = await post(f, 'sync/commits', input, signed.headers)
  expect(response.status).toBe(503)
  const { ApiErrorSchema, CommitRequestSchema } = await import('../../src/account/protocol')
  const evidence = ApiErrorSchema.parse(await response.json()).error.continuation!
  expect(evidence).toMatchObject({ mutationId: input.mutationId, processed: 48 })
  expect(evidence.requestDigest).toBe(await (await import('./storage')).digest(new TextEncoder().encode(JSON.stringify(CommitRequestSchema.parse(input)))))
  const read = () => f.db.prepare('SELECT work_id,processed_steps FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first()
  expect(await read()).toEqual({ work_id: evidence.workId, processed_steps: 48 })
  // Replaying already completed rows and promoting retention are not frontier transitions
  await f.db.prepare('UPDATE publication_pins SET done = 1 WHERE mutation_id = ? AND done = 1').bind(input.mutationId).run()
  await f.db.prepare('UPDATE publication_pins SET retained = 1 WHERE mutation_id = ?').bind(input.mutationId).run()
  expect(await read()).toEqual({ work_id: evidence.workId, processed_steps: 48 })
  const measured = measuredDatabase(f.db), { principal, context } = await direct(f, signed)
  const { commitRevisions } = await import('./commit')
  const receipt = await commitRevisions(principal, input, { ...context, env: { ...context.env, DB: measured.db } })
  expect(receipt.heads).toEqual(input.heads)
  expect(await read()).toEqual({ work_id: evidence.workId, processed_steps: 51 })
  expect(await commitRevisions(principal, input, context)).toEqual(receipt)
  expect(await read()).toEqual({ work_id: evidence.workId, processed_steps: 51 })
  await measurement('continuation', { ...measured.values, processed: 51 })
  // Retire the complete source before removing its operational journal and charged marker
  expect(await (await import('./certificates')).invalidateClosureCertificate(signed.accountId, input.mutationId, context)).toBe(true)
  const before = await f.db.prepare("SELECT metadata_bytes FROM quota_counters WHERE scope = 'global'").first<number>('metadata_bytes')
  const cost = await f.db.prepare('SELECT w.metadata_bytes + p.metadata_bytes + c.metadata_bytes AS cost FROM publication_work w JOIN publication_progress p USING(account_id,mutation_id) JOIN publication_certificates c USING(account_id,mutation_id) WHERE w.mutation_id = ?').bind(input.mutationId).first<number>('cost')
  await f.db.prepare('DELETE FROM publication_certificates WHERE mutation_id = ?').bind(input.mutationId).run()
  await f.db.prepare('DELETE FROM publication_work WHERE mutation_id = ?').bind(input.mutationId).run()
  expect(await read()).toBeNull()
  expect(await f.db.prepare("SELECT metadata_bytes FROM quota_counters WHERE scope = 'global'").first('metadata_bytes')).toBe(before! - cost!)
}, 30_000)
it('staleFrontierCannotAdvanceAReplacementWorkIncarnation', async () => {
  const f = await fixture(), signed = await customer(f), root = await prepared(f, signed)
  const input = command([root.descriptor]), { context, principal } = await direct(f, signed)
  const { commitRevisions } = await import('./commit')
  let batches = 0
  const db = new Proxy(f.db, { get(target, key) {
    if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
      if (++batches === 2) await target.prepare('UPDATE publication_progress SET work_id = ?,processed_steps = 0 WHERE mutation_id = ?').bind(freshId(), input.mutationId).run()
      return target.batch(...args)
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  await expect(commitRevisions(principal, input, { ...context, env: { ...context.env, DB: db } })).rejects.toThrow('INTEGRITY_FAILED')
  expect(await f.db.prepare('SELECT processed_steps FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('processed_steps')).toBe(0)
  expect(await f.db.prepare('SELECT done FROM publication_pins WHERE mutation_id = ?').bind(input.mutationId).first('done')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM sync_documents').first('n')).toBe(0)
})
