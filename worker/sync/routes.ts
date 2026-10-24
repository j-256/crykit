import { z } from 'zod'
import { MutationTransitionDocumentsSchema, maxMutationTransitionQueryBytes, CommitRequestSchema, maxCommitJsonBytes, OpaqueIdSchema, UploadStartSchema, maxChangePageRevisions } from '../../src/account/protocol'
import { requireCustomer } from '../auth/session'
import type { ServiceContext } from '../context'
import { ApiFailure, jsonResponse, readJson } from '../http'
import { commitRevisions, mutationReceipt, revisionDescriptor } from './commit'
import { readChanges } from './changes'
import { readMutationTransition } from './transitions'
import { finishUpload, putUploadChunk, reservation, startUpload } from './uploads'
import { chunkRow, digest, syncBatch } from './storage'
import { admitCloudWork, cloudWorkCost, commitWorkUnits } from '../admission'

const FinishSchema = z.strictObject({version:z.literal(1)})
export async function syncRoute(request: Request, context: ServiceContext): Promise<Response | null> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/api/v1/sync/')) return null
  const principal = await requireCustomer(request,context), path = url.pathname.slice('/api/v1/sync/'.length)
  if (path === 'uploads' && request.method === 'POST') {
    const input = await readJson(request, UploadStartSchema, maxCommitJsonBytes)
    await admitCloudWork(principal, cloudWorkCost.uploadReservation + input.chunks.length, context)
    return jsonResponse(await startUpload(principal, input, context))
  }
  if (path === 'commits' && request.method === 'POST') {
    const input = await readJson(request, CommitRequestSchema, maxCommitJsonBytes)
    await admitCloudWork(principal, commitWorkUnits(input), context)
    return jsonResponse(await commitRevisions(principal, input, context))
  }
  if (path === 'changes' && request.method === 'GET') {
    if ([...url.searchParams.keys()].some(key => !['cursor','limit'].includes(key)) || [...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size) throw new ApiFailure('INVALID_REQUEST')
    return jsonResponse(await readChanges(principal,url.searchParams.get('cursor') || null,Number(url.searchParams.get('limit') ?? maxChangePageRevisions),context))
  }
  const transition = /^mutations\/([^/]+)\/transition$/.exec(path)
  if (transition) {
    if (request.method !== 'GET' || !OpaqueIdSchema.safeParse(transition[1]).success) throw new ApiFailure('NOT_FOUND')
    if (new TextEncoder().encode(url.search).length > maxMutationTransitionQueryBytes || [...url.searchParams.keys()].some(key => key !== 'document')) throw new ApiFailure('INVALID_REQUEST')
    const documents = MutationTransitionDocumentsSchema.safeParse(url.searchParams.getAll('document'))
    if (!documents.success) throw new ApiFailure('INVALID_REQUEST')
    return jsonResponse(await readMutationTransition(principal, transition[1], documents.data, context))
  }
  const match = /^(uploads|revisions|mutations)\/([^/]+)(?:\/(finish|chunks)(?:\/(\d+))?)?$/.exec(path)
  if (!match || !OpaqueIdSchema.safeParse(match[2]).success) throw new ApiFailure('NOT_FOUND')
  const [,kind,id,action,indexText] = match
  if (kind === 'uploads' && action === 'finish' && !indexText && request.method === 'POST') { await readJson(request,FinishSchema,32); await admitCloudWork(principal, cloudWorkCost.finishUpload, context); return jsonResponse(await finishUpload(principal,id,context)) }
  const index = Number(indexText)
  if (kind === 'uploads' && action === 'chunks' && indexText && Number.isSafeInteger(index) && request.method === 'PUT') { await admitCloudWork(principal, cloudWorkCost.uploadChunk, context); await putUploadChunk(principal,id,index,request,context); return jsonResponse({version:1,uploadId:id,index}) }
  if (kind === 'mutations' && !action && request.method === 'GET') {
    const receipt = await mutationReceipt(principal,id,context)
    await syncBatch(principal,'1',[],[],context,'AUTH_REQUIRED',false,false)
    return jsonResponse(receipt ?? {unknown:true})
  }
  if (kind === 'revisions' && request.method === 'GET') {
    const revision = await revisionDescriptor(principal,id,context)
    if (!action) { await syncBatch(principal,'1',[],[],context,'AUTH_REQUIRED',false,false); return jsonResponse(revision) }
    if (action === 'chunks' && indexText && Number.isSafeInteger(index)) {
      const upload = await reservation(principal,revision.uploadId,context), row = await chunkRow(upload.generation,index,context)
      if (row.state !== 'ready') throw new ApiFailure('NOT_FOUND')
      const object = await context.env.OBJECTS!.get(row.object_key)
      if (!object) throw new ApiFailure('NOT_FOUND')
      const bytes = new Uint8Array(await object.arrayBuffer())
      if (bytes.length !== row.cipher_bytes || await digest(bytes) !== row.cipher_digest) throw new ApiFailure('INTEGRITY_FAILED')
      await syncBatch(principal,"EXISTS (SELECT 1 FROM upload_chunks WHERE generation = ? AND chunk_index = ? AND state = 'ready')",[upload.generation,index],[],context,'NOT_FOUND',false,false)
      return new Response(bytes,{headers:{'content-type':'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff'}})
    }
  }
  throw new ApiFailure('NOT_FOUND')
}
