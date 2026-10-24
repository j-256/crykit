import { expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { customer, fixture, post, prepared, command } from '../sync/testing'

const token = () => randomBytes(32).toString('base64url')
const header = (capability: string) => ({ 'x-deletion-status': capability })
async function start(f: Awaited<ReturnType<typeof fixture>>, signed: Awaited<ReturnType<typeof customer>>, capability: string) {
  return post(f, 'account/deletion', { confirmation: 'DELETE MY ACCOUNT' }, { ...signed.headers, ...header(capability) })
}
async function status(f: Awaited<ReturnType<typeof fixture>>, capability: string) {
  return (await f.request('/api/v1/account/deletion', { headers: header(capability) })).json() as Promise<{ state: string; phase: string }>
}
async function drain(f: Awaited<ReturnType<typeof fixture>>, capability: string) {
  for (let index = 0; index < 80 && (await status(f, capability)).state !== 'complete'; index++) { await f.runJobs(); f.advance(60_000) }
  return status(f, capability)
}
it('deletionStopsAccessBeforeRemovingObjectsAndResumes', async () => {
  const f = await fixture(), signed = await customer(f), upload = await prepared(f, signed), capability = token()
  expect((await post(f, 'sync/commits', command([upload.descriptor]), signed.headers)).status).toBe(200)
  expect((await start(f, signed, capability)).status).toBe(202)
  expect((await status(f, capability)).state).not.toBe('complete')
  expect((await post(f, 'sync/uploads', upload.input, signed.headers)).status).toBe(403)
  expect((await f.request('/api/v1/account/deletion')).status).toBe(404)
  expect((await f.request(`/api/v1/account/deletion?capability=${capability}`)).status).toBe(400)
  expect(await f.db.prepare('SELECT access FROM accounts WHERE id = ?').bind(signed.accountId).first('access')).toBe('deleting')
  await f.request('/__accounts/control/initialize-revocations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(await drain(f, capability)).toEqual({state:'complete',phase:'complete'})
  expect(await f.db.prepare('SELECT id FROM accounts WHERE id = ?').bind(signed.accountId).first()).toBeNull()
  const objects = await f.objects.list()
  expect(objects.objects).toHaveLength(1)
  expect(objects.objects[0].size).toBe(32)
  const before = objects.objects[0].etag
  await f.runJobs()
  expect((await f.objects.list()).objects[0].etag).toBe(before)
  expect(await f.db.prepare('SELECT account_id,state,released FROM upload_chunks').first()).toEqual({ account_id: null, state: 'closed', released: 1 })
  expect(await f.db.prepare("SELECT metadata_rows FROM quota_counters WHERE scope='global'").first<number>('metadata_rows')).toBeGreaterThan(1)
})
it('ledgerFailureNeverClaimsRevocationComplete', async () => {
  const f = await fixture(), signed = await customer(f), capability = token()
  expect((await start(f, signed, capability)).status).toBe(202)
  await f.runJobs()
  expect((await status(f, capability)).state).not.toBe('complete')
  expect(await f.db.prepare('SELECT access FROM accounts').first('access')).toBe('deleting')
  await f.request('/__accounts/control/initialize-revocations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(await drain(f, capability)).toEqual({state:'complete',phase:'complete'})
})
it('requires exact confirmation and recent authentication without consuming the capability', async () => {
  const f = await fixture(), signed = await customer(f), capability = token()
  expect((await post(f, 'account/deletion', { confirmation: 'delete' }, { ...signed.headers, ...header(capability) })).status).toBe(400)
  f.advance(10 * 60_000)
  expect((await start(f, signed, capability)).status).toBe(401)
  expect(await f.db.prepare('SELECT access FROM accounts').first('access')).toBe('active')
})
it.each(['deletion.block.before','deletion.block.after'])('keeps authority and journal atomic when interrupted at %s', async stage => {
  const f=await fixture(),owner=await customer(f),capability=token()
  f.failNext(stage)
  expect((await start(f,owner,capability)).status).toBe(503)
  if(stage.endsWith('before')) {
    expect(await f.db.prepare('SELECT access FROM accounts').first('access')).toBe('active')
    expect(await f.db.prepare("SELECT id FROM service_jobs WHERE type='deletion'").first()).toBeNull()
  } else {
    expect((await status(f,capability)).state).toBe('pending')
    expect((await start(f,owner,capability)).status).toBe(202)
    expect(await f.db.prepare("SELECT COUNT(*) AS n FROM service_jobs WHERE type='deletion'").first('n')).toBe(1)
  }
})
it.each(['ledger.event.written','ledger.index.written','ledger.head.written','deletion.ledger.acknowledged','sync.marker.before','sync.marker.written','sync.marker.verified','sync.marker.accounted','deletion.transfer.before','deletion.metadata.before','deletion.envelopes.before','deletion.account.before'])('resumes exact deletion after interruption at %s', async stage => {
  const f=await fixture(),owner=await customer(f),capability=token()
  await prepared(f,owner)
  expect((await f.request('/__accounts/control/initialize-revocations',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(200)
  expect((await start(f,owner,capability)).status).toBe(202)
  f.failNext(stage)
  for(let step=0;step<80 && !f.events().some(event=>event.stage===stage);step++){await f.runJobs();f.advance(60_000)}
  expect(f.events().some(event=>event.stage===stage)).toBe(true)
  expect((await status(f,capability)).state).toBe('pending')
  expect(await drain(f,capability)).toEqual({state:'complete',phase:'complete'})
  expect(await f.db.prepare('SELECT * FROM credentials').all()).toMatchObject({results:[]})
})
it('deletes more than one ledger association limit without capping owned objects',async()=>{
  const {id}=await import('../sync/testing')
  const f=await fixture()
  const retainedServiceMetadata=await f.db.prepare("SELECT reserved_metadata FROM quota_counters WHERE scope='global'").first<number>('reserved_metadata')
  const owner=await customer(f),capability=token()
  for(let upload=0;upload<9;upload++) {
    const input={version:1,uploadId:id(),documentId:id(),revisionId:id(),metadataBytes:1000,chunks:Array.from({length:128},(_,index)=>({index,cipherBytes:33,cipherDigest:randomBytes(32).toString('base64url')}))}
    expect((await post(f,'sync/uploads',input,owner.headers)).status).toBe(200)
  }
  expect((await f.request('/__accounts/control/initialize-revocations',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(200)
  expect((await start(f,owner,capability)).status).toBe(202)
  for(let step=0;step<240 && (await status(f,capability)).state!=='complete';step++){await f.runJobs();f.advance(60_000)}
  expect(await status(f,capability)).toEqual({state:'complete',phase:'complete'})
  expect(await f.db.prepare("SELECT COUNT(*) n FROM upload_chunks WHERE account_id IS NULL AND state='closed' AND released=1").first('n')).toBe(1152)
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope='global'").first('payload_bytes')).toBe(1152*32)
  expect(await f.db.prepare('SELECT SUM(json_array_length(liabilities,\'$[0].entries\')) AS n FROM revocation_intents WHERE acknowledged=1').first('n')).toBe(1152)
  expect(await f.db.prepare("SELECT reserved_metadata FROM quota_counters WHERE scope='global'").first('reserved_metadata')).toBe(retainedServiceMetadata)
  const counters=await f.db.prepare("SELECT * FROM quota_counters WHERE scope='global'").first()
  const ledgerObjects=await f.revocations.list({limit:1000})
  expect(ledgerObjects.truncated).toBe(false)
  await (await import('../sync/testing')).measurement('o02-large-deletion',{managedObjects:1152,counters,independentLedgerObjects:ledgerObjects.objects.length,independentLedgerObjectBytes:ledgerObjects.objects.reduce((sum,row)=>sum+row.size,0)})

},60_000)
it.each(['accounts','customer_sessions','devices','shares'])('rolls the complete authority block back when %s mutation fails',async table=>{
  const f=await fixture(),owner=await customer(f),capability=token()
  if(table==='shares') await f.db.prepare("INSERT INTO shares(id,account_id,revision,snapshot_revision,state,include_attribution,created_at,updated_at) VALUES (?,?,1,1,'active',0,0,0)").bind(token().slice(0,22),owner.accountId).run()
  await f.db.prepare(`CREATE TRIGGER fail_deletion BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`).run()
  expect((await start(f,owner,capability)).status).toBe(503)
  expect(await f.db.prepare('SELECT access FROM accounts').first('access')).toBe('active')
  expect(await f.db.prepare("SELECT COUNT(*) n FROM service_jobs WHERE type='deletion'").first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM customer_sessions WHERE revoked_at IS NOT NULL').first('n')).toBe(0)
})
it.each(['pending_registrations','credentials','accounts'])('keeps completion pending after actual %s removal failure',async table=>{
  const f=await fixture(),owner=await customer(f),capability=token()
  await f.request('/__accounts/control/initialize-revocations',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
  expect((await start(f,owner,capability)).status).toBe(202)
  await f.db.prepare(`CREATE TRIGGER fail_deletion BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`).run()
  expect((await drain(f,capability)).state).toBe('pending')
  expect(await f.db.prepare('SELECT access FROM accounts').first('access')).toBe('deleting')
  await f.db.prepare('DROP TRIGGER fail_deletion').run()
  expect(await drain(f,capability)).toEqual({state:'complete',phase:'complete'})
})
it.each(['initializer','body'] as const)('fences actual delayed %s writer through complete account deletion',async phase=>{
  const {direct,id}=await import('../sync/testing'),{writeFencedChunk,decode}=await import('../sync/storage'),{createHash}=await import('node:crypto')
  const f=await fixture(),owner=await customer(f),capability=token(),{context,principal}=await direct(f,owner)
  const bytes=randomBytes(33),input={version:1,uploadId:id(),documentId:id(),revisionId:id(),metadataBytes:1000,chunks:[{index:0,cipherBytes:bytes.length,cipherDigest:createHash('sha256').update(bytes).digest('base64url')}]}
  expect((await post(f,'sync/uploads',input,owner.headers)).status).toBe(200)
  const row=await f.db.prepare('SELECT generation,object_key,marker FROM upload_chunks').first<{generation:string;object_key:string;marker:string}>()
  let entered!:()=>void,release!:()=>void
  const arrived=new Promise<void>(resolve=>{entered=resolve}),resume=new Promise<void>(resolve=>{release=resolve})
  const objects=new Proxy(context.env.OBJECTS!,{get(target,key){
    if(key==='delete')return ()=>{throw new Error('Managed keys must not be deleted')}
    if(key==='put')return async(...args:Parameters<typeof target.put>)=>{const options=args[2] as {onlyIf?:{etagMatches?:string;etagDoesNotMatch?:string}}|undefined;if((phase==='initializer'&&options?.onlyIf?.etagDoesNotMatch)||(phase==='body'&&options?.onlyIf?.etagMatches)){entered();await resume}return target.put(...args)}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  const delayed=writeFencedChunk(principal,row!.generation,0,bytes,{...context,env:{...context.env,OBJECTS:objects}}).catch(error=>error)
  await arrived
  try {
    await f.request('/__accounts/control/initialize-revocations',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
    expect((await start(f,owner,capability)).status).toBe(202)
    expect(await drain(f,capability)).toEqual({state:'complete',phase:'complete'})
  } finally {release()}
  expect(await delayed).toBeInstanceOf(Error)
  expect(new Uint8Array(await (await f.objects.get(row!.object_key))!.arrayBuffer())).toEqual(decode(row!.marker))
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope='global'").first('payload_bytes')).toBe(32)
})
it('invalidates actual queued email and device capabilities while immediately stopping published links',async()=>{
  const {id}=await import('../sync/testing'),{deviceSecretHash}=await import('../../src/account/protocol')
  const f=await fixture(),owner=await customer(f),capability=token(),requestId=id(),requestCapability=token(),requestPublicKey=token()
  expect((await post(f,'account/email/start',{transactionId:id(),expectedRevision:1,email:'changed@example.org'},owner.headers)).status).toBe(200)
  const before=(await f.emails()).length
  expect((await post(f,'auth/devices/start',{requestId,email:'sync@example.org',requestPublicKey,requestCapabilityHash:await deviceSecretHash(requestCapability)})).status).toBe(200)
  expect((await post(f,'account/devices/approve',{requestId,requestPublicKey,sealedPayload:randomBytes(100).toString('base64url'),completionHash:token()},owner.headers)).status).toBe(200)
  const shareId=id()
  await f.db.prepare("INSERT INTO shares(id,account_id,revision,snapshot_revision,state,include_attribution,created_at,updated_at) VALUES (?,?,1,1,'active',0,0,0)").bind(shareId,owner.accountId).run()
  expect((await start(f,owner,capability)).status).toBe(202)
  expect((await f.request(`/api/public/v1/shares/${shareId}`)).status).toBe(404)
  expect(await f.db.prepare('SELECT sealed_payload,capability_hash FROM device_approvals WHERE id=?').bind(requestId).first()).toEqual({sealed_payload:null,capability_hash:''})
  expect((await post(f,'auth/devices/status',{requestId,requestCapability})).status).toBe(400)
  expect((await post(f,'auth/devices/start',{requestId:id(),email:'sync@example.org',requestPublicKey:token(),requestCapabilityHash:token()})).status).toBe(200)
  expect(await f.db.prepare("SELECT COUNT(*) n FROM device_approvals WHERE account_id=? AND state='pending'").bind(owner.accountId).first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM email_jobs WHERE eligible=1 OR payload IS NOT NULL').first('n')).toBe(0)
  await f.runJobs()
  expect((await f.emails()).length).toBe(before)
})
it('keeps a delayed identical marker harmless after another leased worker completes deletion',async()=>{
  const {direct}=await import('../sync/testing'),{runServiceJobs}=await import('./runner'),{decode}=await import('../sync/storage')
  const f=await fixture(),owner=await customer(f),capability=token(),{context}=await direct(f,owner)
  await prepared(f,owner)
  const row=await f.db.prepare('SELECT object_key,marker FROM upload_chunks').first<{object_key:string;marker:string}>()
  await f.request('/__accounts/control/initialize-revocations',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
  expect((await start(f,owner,capability)).status).toBe(202)
  await f.runJobs();await f.runJobs()
  expect((await status(f,capability)).phase).toBe('fence')
  let entered!:()=>void,release!:()=>void,held=false
  const arrived=new Promise<void>(resolve=>{entered=resolve}),resume=new Promise<void>(resolve=>{release=resolve})
  const objects=new Proxy(context.env.OBJECTS!,{get(target,key){
    if(key==='put')return async(...args:Parameters<typeof target.put>)=>{if(!held){held=true;entered();await resume}return target.put(...args)}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  const delayed=runServiceJobs({...context,env:{...context.env,OBJECTS:objects,REVOCATION_LEDGER:f.revocations as unknown as R2Bucket}},10)
  await arrived
  let before:unknown
  try {
    f.advance(60_001)
    expect(await drain(f,capability)).toEqual({state:'complete',phase:'complete'})
    before=await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope='global'").first('payload_bytes')
  } finally {release()}
  await delayed
  expect(new Uint8Array(await (await f.objects.get(row!.object_key))!.arrayBuffer())).toEqual(decode(row!.marker))
  expect(await f.db.prepare("SELECT payload_bytes FROM quota_counters WHERE scope='global'").first('payload_bytes')).toBe(before)
})

it.each(['interrupted','late-writer'] as const)('finishes the original partial share Stop before deletion with %s recovery',async mode=>{
  const {direct,id}=await import('../sync/testing'),{stopSharing}=await import('../shares/publication')
  const {runServiceJobs}=await import('./runner'),{verifyRevocationLedgerPage,readRevocation}=await import('./ledger')
  const f=await fixture(),owner=await customer(f),capability=token(),{context,principal}=await direct(f,owner)
  await f.request('/__accounts/control/initialize-revocations',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})
  const snapshot={version:5,kind:'build',title:'Synthetic recovery build',setup:{catalogLock:{'exact-public-baseline':'historical-source-v1'},baseline:null,layers:[],mode:{state:'unknown'},ppCostsNonNegative:{state:'unknown'},slots:[]},slots:[{primaryClass:null,secondaryClass:null,equipment:[],equipmentGroups:[],passives:[]}],receipts:[]}
  const published=await post(f,'shares',{mutationId:id(),snapshot,includeAttribution:false},owner.headers)
  expect(published.status).toBe(200)
  const {shareId}=await published.json() as {shareId:string},mutationId=id()
  const ledgerContext={...context,env:{...context.env,SERVICE_ORIGIN:'http://127.0.0.1',REVOCATION_LEDGER:f.revocations as unknown as R2Bucket}}
  let release!:()=>void,entered!:()=>void,held=false
  const arrived=new Promise<void>(resolve=>{entered=resolve}),resume=new Promise<void>(resolve=>{release=resolve})
  const ledger=new Proxy(ledgerContext.env.REVOCATION_LEDGER,{get(target,key){
    if(key==='put')return async(...args:Parameters<typeof target.put>)=>{const result=await target.put(...args);if(!held&&String(args[0]).includes('/events/')){held=true;entered();await resume}return result}
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
  }})
  let late:Promise<unknown>|undefined
  if(mode==='late-writer') {
    late=stopSharing(principal,shareId,{mutationId,expectedRevision:1},{...ledgerContext,env:{...ledgerContext.env,REVOCATION_LEDGER:ledger}}).catch(error=>error)
    await arrived
  } else {
    f.failNext('ledger.event.written')
    expect((await f.request(`/api/v1/shares/${shareId}`,{method:'DELETE',headers:{origin:'http://127.0.0.1','content-type':'application/json',...owner.headers},body:JSON.stringify({mutationId,expectedRevision:1})})).status).toBe(503)
  }
  const frozen=await f.db.prepare('SELECT event FROM share_mutations WHERE mutation_id=?').bind(mutationId).first<string>('event')
  const event=JSON.parse(frozen!)
  try {
    expect((await start(f,owner,capability)).status).toBe(202)
    const unavailable=new Proxy(ledgerContext.env.REVOCATION_LEDGER,{get(){return async()=>{throw new Error('synthetic outage')}}})
    await runServiceJobs({...ledgerContext,env:{...ledgerContext.env,REVOCATION_LEDGER:unavailable}},10)
    expect((await status(f,capability)).state).toBe('pending')
    expect(await f.db.prepare('SELECT event FROM share_mutations WHERE mutation_id=?').bind(mutationId).first('event')).toBe(frozen)
    f.advance(60_000)
    expect(await drain(f,capability)).toEqual({state:'complete',phase:'complete'})
    expect(await readRevocation(event.intentId,ledgerContext)).toEqual(event)
    let completePage=await verifyRevocationLedgerPage(ledgerContext)
    while(completePage.next)completePage=await verifyRevocationLedgerPage(ledgerContext,completePage.next)
  } finally {release()}
  if(late) expect(await late).toBeInstanceOf(Error)
  expect(await readRevocation(event.intentId,ledgerContext)).toEqual(event)
  let page=await verifyRevocationLedgerPage(ledgerContext)
  const events=[...page.events]
  while(page.next){page=await verifyRevocationLedgerPage(ledgerContext,page.next);events.push(...page.events)}
  expect(events.filter(value=>value.kind==='share-stopped')).toEqual([event])
  expect(await f.db.prepare('SELECT id FROM accounts WHERE id=?').bind(owner.accountId).first()).toBeNull()
})
