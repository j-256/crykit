import { z } from 'zod'
import { maxChangePageRevisions, maxChangedHeads, type ChangePage, OpaqueIdSchema } from '../../src/account/protocol'
import { encode, keyedHash, randomId } from '../auth/identity'
import type { CustomerPrincipal } from '../auth/session'
import type { ServiceContext } from '../context'
import { ApiFailure } from '../http'
import { revisionDescriptor } from './commit'
import { decode, encoder, syncBatch } from './storage'

export const scanLeaseMs = 30 * 60 * 1000
const CursorSchema = z.strictObject({ version: z.literal(1), account: OpaqueIdSchema, lease: OpaqueIdSchema, mode: z.enum(['initial','incremental']), watermark: z.number().int().nonnegative().safe(), epoch: z.number().int().nonnegative().safe(), first: z.number().int().nonnegative().safe(), document: z.string().max(22), after: z.number().int().nonnegative().safe(), expires: z.number().int().nonnegative().safe() })
type Cursor = z.infer<typeof CursorSchema>
async function signCursor(cursor: Cursor, context: ServiceContext): Promise<string> {
  const payload = encode(encoder.encode(JSON.stringify(cursor)))
  return `${payload}.${await keyedHash(context.env.CURSOR_SECRET,'sync-cursor',payload)}`
}
async function parseCursor(value: string, principal: CustomerPrincipal, context: ServiceContext): Promise<Cursor> {
  if (value.length > 2048) throw new ApiFailure('STALE_CURSOR')
  const [payload, signature, extra] = value.split('.')
  if (!payload || !signature || extra || signature !== await keyedHash(context.env.CURSOR_SECRET,'sync-cursor',payload)) throw new ApiFailure('STALE_CURSOR')
  let cursor: Cursor
  try { cursor = CursorSchema.parse(JSON.parse(new TextDecoder().decode(decode(payload)))) } catch { throw new ApiFailure('STALE_CURSOR') }
  if (cursor.account !== principal.accountId || cursor.expires <= context.now()) throw new ApiFailure('STALE_CURSOR')
  return cursor
}
export async function readChanges(principal: CustomerPrincipal, value: string | null, limit: number, context: ServiceContext): Promise<ChangePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxChangePageRevisions) throw new ApiFailure('INVALID_REQUEST')
  const db = context.env.DB!, accountId = principal.accountId
  let cursor: Cursor
  if (value) cursor = await parseCursor(value,principal,context)
  else {
    const id = randomId(), expires = context.now() + scanLeaseMs
    // Capture the lease, W and E in one SQL observation inside live read authority
    const results = await syncBatch(principal,'1',[],[db.prepare('INSERT INTO scan_leases(account_id,id,watermark,publication_epoch,expires_at) SELECT ?,?,COALESCE(sequence,0),COALESCE(publication_epoch,0),? FROM (SELECT 1) LEFT JOIN account_sequences ON account_id = ? RETURNING watermark,publication_epoch').bind(accountId,id,expires,accountId)],context,'AUTH_REQUIRED',false)
    const row = results[0].results[0] as { watermark: number; publication_epoch: number }
    cursor = { version:1, account:accountId,lease:id,mode:'initial',watermark:row.watermark,epoch:row.publication_epoch,first:0,document:'',after:row.watermark,expires }
  }
  const lease = await db.prepare('SELECT 1 FROM scan_leases WHERE id = ? AND account_id = ? AND expires_at > ?').bind(cursor.lease,accountId,context.now()).first()
  if (!lease) throw new ApiFailure('STALE_CURSOR')
  const groups: ChangePage['groups'][number][] = []
  let hasMore = false, watermark = cursor.watermark, epoch = cursor.epoch
  if (cursor.mode === 'initial') {
    const rows = await db.prepare(`SELECT d.document_id,d.first_sequence,(SELECT revision_id FROM head_history h WHERE h.account_id = d.account_id AND h.document_id = d.document_id AND h.sequence <= ? ORDER BY h.sequence DESC LIMIT 1) AS revision_id FROM sync_documents d WHERE d.account_id = ? AND d.first_sequence <= ? AND (d.first_sequence,d.document_id) > (?,?) ORDER BY d.first_sequence,d.document_id LIMIT ?`).bind(cursor.watermark,accountId,cursor.watermark,cursor.first,cursor.document,limit + 1).all<{ document_id:string; first_sequence:number; revision_id:string | null }>()
    hasMore = rows.results.length > limit
    for (let start = 0; start < Math.min(rows.results.length,limit); start += maxChangedHeads) {
      const page = rows.results.slice(start, Math.min(start+maxChangedHeads,limit))
      if (page.some(row => row.revision_id === null)) throw new ApiFailure('STALE_CURSOR')
      const revisions = []
      for (const row of page) revisions.push(await revisionDescriptor(principal,row.revision_id!,context))
      groups.push({ sequence:cursor.watermark,mutationId:cursor.lease,revisions,heads:page.map(row => ({documentId:row.document_id,revisionId:row.revision_id!})) })
    }
    const last = rows.results.slice(0,limit).at(-1)
    cursor = { ...cursor,first:last?.first_sequence ?? cursor.first,document:last?.document_id ?? cursor.document,mode:hasMore?'initial':'incremental' }
  } else {
    // One observation captures the upper pair; commands at or below it are immutable
    const pair = cursor.after < cursor.watermark ? {sequence:cursor.watermark,publication_epoch:cursor.epoch} : await db.prepare('SELECT sequence,publication_epoch FROM account_sequences WHERE account_id = ?').bind(accountId).first<{sequence:number;publication_epoch:number}>()
    watermark = pair?.sequence ?? 0; epoch = pair?.publication_epoch ?? 0
    const rows = await db.prepare('SELECT group_json FROM mutation_receipts WHERE account_id = ? AND sequence > ? AND sequence <= ? ORDER BY sequence LIMIT ?').bind(accountId,cursor.after,watermark,limit+1).all<{group_json:string}>()
    let units = 0
    for (const row of rows.results) {
      const group = JSON.parse(row.group_json) as ChangePage['groups'][number], cost = Math.max(group.revisions.length,group.heads.length)
      if (groups.length > 0 && units + cost > limit) { hasMore = true; break }
      groups.push(group); units += cost; cursor = {...cursor,after:group.sequence}
    }
    cursor = {...cursor,watermark,epoch}
  }
  // Recheck authority after reads so revocation cannot turn a captured principal into a read grant
  await syncBatch(principal,'EXISTS (SELECT 1 FROM scan_leases WHERE id = ? AND account_id = ? AND expires_at > ?)',[cursor.lease,accountId,context.now()],[],context,'STALE_CURSOR',false,false)
  return {version:1,mode:value ? (await parseCursor(value,principal,context)).mode : 'initial',watermark,publicationEpoch:epoch,cursor:await signCursor(cursor,context),hasMore,groups}
}
