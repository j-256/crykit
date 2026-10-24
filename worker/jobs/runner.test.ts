import { expect,it } from 'vitest'
import { customer,fixture,id,post,direct } from '../sync/testing'
import { runServiceJobs,reconcileLedger } from './runner'
import { initializeRevocationLedger,readRevocationHead } from './ledger'

it('reconciles the exact stopped-share event after the authorizing session is revoked',async()=>{
  const f=await fixture(),owner=await customer(f),{context}=await direct(f,owner)
  const snapshot={version:5,kind:'build',title:'Synthetic published build',setup:{catalogLock:{'exact-public-baseline':'historical-source-v1'},baseline:null,layers:[],mode:{state:'unknown'},ppCostsNonNegative:{state:'unknown'},slots:[]},slots:[{primaryClass:null,secondaryClass:null,equipment:[],equipmentGroups:[],passives:[]}],receipts:[]}
  const published=await post(f,'shares',{mutationId:id(),snapshot,includeAttribution:false},owner.headers)
  expect(published.status).toBe(200)
  const {shareId}=await published.json() as {shareId:string},mutationId=id()
  const stopping=await f.request(`/api/v1/shares/${shareId}`,{method:'DELETE',headers:{origin:'http://127.0.0.1','content-type':'application/json',...owner.headers},body:JSON.stringify({mutationId,expectedRevision:1})})
  expect(stopping.status).toBe(503)
  const event=await f.db.prepare('SELECT event FROM share_mutations WHERE mutation_id=?').bind(mutationId).first<string>('event')
  await f.db.prepare('UPDATE customer_sessions SET revoked_at=1').run()
  const ledgerContext={...context,env:{...context.env,SERVICE_ORIGIN:'http://127.0.0.1',REVOCATION_LEDGER:f.revocations as unknown as R2Bucket}}
  await initializeRevocationLedger(ledgerContext)
  await reconcileLedger(ledgerContext)
  expect(await f.db.prepare('SELECT state,revision FROM shares WHERE id=?').bind(shareId).first()).toEqual({state:'stopped',revision:2})
  expect(await f.db.prepare('SELECT event FROM share_mutations WHERE mutation_id=?').bind(mutationId).first('event')).toBe(event)
  expect(JSON.parse((await f.db.prepare('SELECT receipt FROM share_mutations WHERE mutation_id=?').bind(mutationId).first<string>('receipt'))!)).toMatchObject({active:false,revision:2})
  expect((await f.request(`/api/public/v1/shares/${shareId}`)).status).toBe(404)
  await reconcileLedger(ledgerContext)
  expect((await readRevocationHead(ledgerContext)).sequence).toBe(1)
})
it('rejects unbounded scheduler work and coordinates concurrent cleanup runners',async()=>{
  const f=await fixture(),owner=await customer(f),{context}=await direct(f,owner)
  await expect(runServiceJobs(context,101)).rejects.toThrow('Invalid service job limit')
  const before=await f.db.prepare("SELECT attempts FROM service_jobs WHERE type='cleanup'").first<number>('attempts')
  await Promise.all([runServiceJobs(context,1),runServiceJobs(context,1),runServiceJobs(context,1)])
  expect(await f.db.prepare("SELECT COUNT(*) n FROM service_jobs WHERE type='cleanup'").first('n')).toBe(1)
  const row=await f.db.prepare("SELECT attempts,outcome,lease_token FROM service_jobs WHERE type='cleanup'").first<{attempts:number;outcome:string;lease_token:string|null}>()
  expect(row!.attempts).toBeGreaterThan(before!)
  expect(row!.attempts).toBeLessThanOrEqual(before!+3)
  expect(row!.lease_token).toBeNull()
  expect(row!.outcome).toBe('complete')
})
