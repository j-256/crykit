import { z } from 'zod'
import { DigestSchema, OpaqueIdSchema, base64urlSchema } from '../../src/account/protocol'
import type { ServiceContext } from '../context'

export const ledgerLimits = Object.freeze({ objectBytes: 16384, pageEntries: 32, manifestPages: 32, scanObjects: 8, appendAttempts: 16 })
const version = z.literal(1)
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const common = { version, intentId: OpaqueIdSchema, sessionEpoch: uint, timestamp: uint }
export const RevocationEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('share-stopped'), accountId: OpaqueIdSchema, shareId: OpaqueIdSchema }),
  z.strictObject({ ...common, kind: z.literal('account-deleted'), accountId: OpaqueIdSchema }),
  z.strictObject({ ...common, kind: z.literal('operator-revoked'), operatorId: OpaqueIdSchema }),
  z.strictObject({ ...common, kind: z.literal('invitation-revoked'), invitationId: OpaqueIdSchema, operatorId: OpaqueIdSchema }),
])
export type RevocationEvent = z.infer<typeof RevocationEventSchema>
const markerBytes = 32
const LiabilitySchema = z.strictObject({
  managedKey: z.string().regex(/^sync\/[A-Za-z0-9_-]{22}$/).refine(key => OpaqueIdSchema.safeParse(key.slice(5)).success),
  markerIdentity: base64urlSchema(markerBytes), markerDigest: DigestSchema,
  retainedBytes: z.literal(markerBytes), closed: z.literal(true), payloadReleased: z.literal(true),
})
export const ClosedLiabilityPageSchema = z.strictObject({ version, intentId: OpaqueIdSchema, page: uint, entries: z.array(LiabilitySchema).min(1).max(ledgerLimits.pageEntries) })
export type ClosedLiabilityPage = z.infer<typeof ClosedLiabilityPageSchema>
const ManifestSchema = z.strictObject({ version, intentId: OpaqueIdSchema, pageDigests: z.array(DigestSchema).max(ledgerLimits.manifestPages) })
const RecordSchema = z.strictObject({ version, event: RevocationEventSchema, manifest: ManifestSchema.nullable() })
type RecordBody = z.infer<typeof RecordSchema>
const HeadSchema = z.strictObject({ version, sequence: uint, digest: DigestSchema.nullable() }).refine(head => (head.sequence === 0) === (head.digest === null))
export type RevocationHead = z.infer<typeof HeadSchema>
const ClaimSchema = z.strictObject({ version, sequence: uint.min(1) })
const IndexSchema = z.strictObject({ version, sequence: uint.min(1), previousDigest: DigestSchema.nullable(), intentId: OpaqueIdSchema, recordDigest: DigestSchema })
type IndexBody = z.infer<typeof IndexSchema>
const genesis: RevocationHead = { version: 1, sequence: 0, digest: null }
const prefix = 'revocations/v1/'
const headKey = `${prefix}head`
const eventKey = (intent: string) => `${prefix}events/${intent}`
const claimKey = (intent: string) => `${prefix}claims/${intent}`
const indexKey = (sequence: number) => `${prefix}index/${String(sequence).padStart(16, '0')}`
const manifestKey = (intent: string) => `${prefix}manifests/${intent}/association`
const pageKey = (intent: string, page: number) => `${prefix}manifests/${intent}/${String(page).padStart(4, '0')}`
const encoder = new TextEncoder()
export type LedgerFailureCode = 'LEDGER_UNAVAILABLE' | 'LEDGER_NOT_READY' | 'LEDGER_INVALID' | 'LEDGER_CORRUPT' | 'LEDGER_INCOMPLETE' | 'LEDGER_REGRESSED' | 'LEDGER_INTENT_MISMATCH' | 'LEDGER_CONTENTION' | 'LEDGER_CHANGED'
export class LedgerFailure extends Error {
  constructor(readonly code: LedgerFailureCode) { super(code); this.name = 'LedgerFailure' }
}
function fail(code: LedgerFailureCode): never { throw new LedgerFailure(code) }
function bucket(context: ServiceContext) {
  const result = context.env.REVOCATION_LEDGER
  if (!result || result === context.env.OBJECTS || result === context.env.LEDGER_BACKUPS) fail('LEDGER_NOT_READY')
  return result
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}
async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function parse<T>(schema: z.ZodType<T>, value: unknown, code: LedgerFailureCode = 'LEDGER_INVALID'): T {
  const result = schema.safeParse(value)
  if (!result.success) fail(code)
  return result.data
}
async function operation<T>(context: ServiceContext, run: () => Promise<T>): Promise<T> {
  const start = context.now()
  try { return await run() } catch (error) {
    const failure = error instanceof LedgerFailure ? error : new LedgerFailure('LEDGER_UNAVAILABLE')
    context.emit({ operation: 'revocation-ledger', stage: 'failed', code: failure.code, durationMs: Math.max(0, context.now() - start) })
    throw failure
  }
}
async function read<T>(key: string, schema: z.ZodType<T>, context: ServiceContext) {
  const object = await bucket(context).get(key)
  if (!object) return null
  if (object.size > ledgerLimits.objectBytes) fail('LEDGER_CORRUPT')
  const text = await object.text()
  if (encoder.encode(text).length !== object.size) fail('LEDGER_CORRUPT')
  let value: unknown
  try { value = JSON.parse(text) } catch { fail('LEDGER_CORRUPT') }
  const body = parse(schema, value, 'LEDGER_CORRUPT')
  if (text !== canonical(body)) fail('LEDGER_CORRUPT')
  return { body, text, digest: await digest(text), etag: object.etag }
}
async function immutable<T>(key: string, body: T, schema: z.ZodType<T>, context: ServiceContext) {
  const text = canonical(body)
  if (encoder.encode(text).length > ledgerLimits.objectBytes) fail('LEDGER_INVALID')
  await bucket(context).put(key, text, { onlyIf: { etagDoesNotMatch: '*' } })
  const stored = await read(key, schema, context)
  if (!stored) fail('LEDGER_INCOMPLETE')
  if (stored.text !== text) fail('LEDGER_INTENT_MISMATCH')
  return stored
}
async function discoverable(key: string, stored: { text: string; etag: string }, context: ServiceContext) {
  const listed = (await bucket(context).list({ prefix: key, limit: 1 })).objects[0]
  if (listed?.key === headKey && listed.etag !== stored.etag) fail('LEDGER_CHANGED')
  if (!listed || listed.key !== key || listed.size !== encoder.encode(stored.text).length || listed.etag !== stored.etag) fail('LEDGER_INCOMPLETE')
}
async function rawHead(context: ServiceContext) {
  const head = await read(headKey, HeadSchema, context)
  if (!head) fail('LEDGER_NOT_READY')
  if (head.body.sequence > 0) {
    const index = await read(indexKey(head.body.sequence), IndexSchema, context)
    if (!index || index.body.sequence !== head.body.sequence || index.digest !== head.body.digest) fail('LEDGER_INCOMPLETE')
  }
  return head
}

// Provisioning must explicitly initialize an empty independent resource; a lost head is never reset
export async function initializeRevocationLedger(context: ServiceContext): Promise<void> {
  return operation(context, async () => {
    if (await read(headKey, HeadSchema, context)) { await rawHead(context); return }
    if ((await bucket(context).list({ limit: 1 })).objects.length) fail('LEDGER_NOT_READY')
    await bucket(context).put(headKey, canonical(genesis), { onlyIf: { etagDoesNotMatch: '*' } })
    await rawHead(context)
  })
}

async function verifyLiabilities(pages: readonly ClosedLiabilityPage[]) {
  const keys = new Set<string>()
  for (const page of pages) {
    for (const entry of page.entries) {
      if (keys.has(entry.managedKey)) fail('LEDGER_CORRUPT')
      keys.add(entry.managedKey)
      const bytes = Uint8Array.from(atob(entry.markerIdentity.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const encoded = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      if (bytes[0] !== 1 || bytes[1] !== 1 || encoded !== entry.markerDigest) fail('LEDGER_CORRUPT')
    }
  }
}
async function verifyManifest(manifest: z.infer<typeof ManifestSchema>, context: ServiceContext) {
  const association = await read(manifestKey(manifest.intentId), ManifestSchema, context)
  if (!association || association.text !== canonical(manifest)) fail('LEDGER_INCOMPLETE')
  await discoverable(manifestKey(manifest.intentId), association, context)
  const pages: ClosedLiabilityPage[] = []
  for (const [position, expectedDigest] of manifest.pageDigests.entries()) {
    const page = await read(pageKey(manifest.intentId, position), ClosedLiabilityPageSchema, context)
    if (!page || page.digest !== expectedDigest || page.body.intentId !== manifest.intentId || page.body.page !== position) fail('LEDGER_INCOMPLETE')
    await discoverable(pageKey(manifest.intentId, position), page, context)
    pages.push(page.body)
  }
  await verifyLiabilities(pages)
  return pages
}

// This records opaque evidence supplied by the deletion owner, not proof of live payload removal
// The versioned association is immutable, including the explicit empty-liability case
export async function prepareRevocationLiabilities(intentId: string, pages: readonly ClosedLiabilityPage[], context: ServiceContext): Promise<void> {
  return operation(context, async () => {
    parse(OpaqueIdSchema, intentId)
    if (pages.length > ledgerLimits.manifestPages) fail('LEDGER_INVALID')
    await rawHead(context)
    const parsed = pages.map((page, index) => {
      const result = parse(ClosedLiabilityPageSchema, page)
      if (result.intentId !== intentId || result.page !== index) fail('LEDGER_INVALID')
      return result
    })
    const manifest = { version: 1 as const, intentId, pageDigests: await Promise.all(parsed.map(page => digest(canonical(page)))) }
    const existing = await read(eventKey(intentId), RecordSchema, context)
    if (existing && canonical(existing.body.manifest) !== canonical(manifest)) fail('LEDGER_INTENT_MISMATCH')
    await verifyLiabilities(parsed)
    // Freeze association before pages so a changed retry cannot leave unbound permanent objects
    await immutable(manifestKey(intentId), manifest, ManifestSchema, context)
    for (const page of parsed) await immutable(pageKey(intentId, page.page), page, ClosedLiabilityPageSchema, context)
    await verifyManifest(manifest, context)
  })
}
async function record(intentId: string, context: ServiceContext) {
  const stored = await read(eventKey(intentId), RecordSchema, context)
  if (!stored || stored.body.event.intentId !== intentId) fail('LEDGER_INCOMPLETE')
  if (stored.body.event.kind === 'account-deleted') {
    if (!stored.body.manifest || stored.body.manifest.intentId !== intentId) fail('LEDGER_INCOMPLETE')
    await verifyManifest(stored.body.manifest, context)
  } else if (stored.body.manifest !== null) fail('LEDGER_CORRUPT')
  return stored
}
async function indexCoverage(index: IndexBody, context: ServiceContext) {
  const stored = await record(index.intentId, context)
  if (stored.digest !== index.recordDigest) fail('LEDGER_INCOMPLETE')
  const claim = await read(claimKey(index.intentId), ClaimSchema, context)
  if (!claim || claim.body.sequence !== index.sequence) fail('LEDGER_INCOMPLETE')
  return stored.body.event
}
async function covered(intentId: string, context: ServiceContext) {
  const stored = await record(intentId, context)
  const claim = await read(claimKey(intentId), ClaimSchema, context)
  if (!claim) fail('LEDGER_INCOMPLETE')
  const index = await read(indexKey(claim.body.sequence), IndexSchema, context)
  if (!index || index.body.sequence !== claim.body.sequence || index.body.intentId !== intentId || index.body.recordDigest !== stored.digest) fail('LEDGER_INCOMPLETE')
  const head = await rawHead(context)
  if (head.body.sequence < claim.body.sequence) fail('LEDGER_INCOMPLETE')
  await discoverable(eventKey(intentId), stored, context)
  await discoverable(indexKey(claim.body.sequence), index, context)
  await discoverable(headKey, head, context)
  return stored.body.event
}

export async function appendRevocation(event: RevocationEvent, context: ServiceContext): Promise<void> {
  return operation(context, async () => {
    const input = parse(RevocationEventSchema, event)
    await rawHead(context)
    const manifest = input.kind === 'account-deleted' ? await read(manifestKey(input.intentId), ManifestSchema, context) : null
    if (input.kind === 'account-deleted' && !manifest) fail('LEDGER_INCOMPLETE')
    if (manifest && manifest.body.intentId !== input.intentId) fail('LEDGER_CORRUPT')
    const body: RecordBody = { version: 1, event: input, manifest: manifest?.body ?? null }
    if (body.manifest) await verifyManifest(body.manifest, context)
    const stored = await immutable(eventKey(input.intentId), body, RecordSchema, context)
    context.checkpoint('ledger.event.written')
    for (let attempt = 0; attempt < ledgerLimits.appendAttempts; attempt++) {
      const head = await rawHead(context)
      let claim = await read(claimKey(input.intentId), ClaimSchema, context)
      if (claim) {
        const slot = await read(indexKey(claim.body.sequence), IndexSchema, context)
        if (slot?.body.intentId === input.intentId && claim.body.sequence <= head.body.sequence) {
          try { await covered(input.intentId, context) } catch (error) {
            // Only the mutable head can advance between GET and LIST; retry that race within the same budget
            if (error instanceof LedgerFailure && error.code === 'LEDGER_CHANGED') continue
            throw error
          }
          context.checkpoint('ledger.acknowledged')
          return
        }
        if (claim.body.sequence > head.body.sequence + 1) fail('LEDGER_REGRESSED')
        // Move a reservation only after its old slot is permanently occupied by another intent
        // A delayed writer can then never fill that old slot after the reservation moves
        if (slot && slot.body.intentId !== input.intentId) {
          await bucket(context).put(claimKey(input.intentId), canonical({ version: 1, sequence: head.body.sequence + 1 }), { onlyIf: { etagMatches: claim.etag } })
          claim = await read(claimKey(input.intentId), ClaimSchema, context)
        }
      } else {
        await bucket(context).put(claimKey(input.intentId), canonical({ version: 1, sequence: head.body.sequence + 1 }), { onlyIf: { etagDoesNotMatch: '*' } })
        claim = await read(claimKey(input.intentId), ClaimSchema, context)
      }
      if (!claim) fail('LEDGER_INCOMPLETE')
      if (claim.body.sequence === head.body.sequence + 1) {
        const next: IndexBody = { version: 1, sequence: claim.body.sequence, previousDigest: head.body.digest, intentId: input.intentId, recordDigest: stored.digest }
        await bucket(context).put(indexKey(next.sequence), canonical(next), { onlyIf: { etagDoesNotMatch: '*' } })
        context.checkpoint('ledger.index.written')
      }
      const next = await read(indexKey(head.body.sequence + 1), IndexSchema, context)
      if (!next) fail('LEDGER_INCOMPLETE')
      if (next.body.sequence !== head.body.sequence + 1 || next.body.previousDigest !== head.body.digest) fail('LEDGER_CORRUPT')
      await indexCoverage(next.body, context)
      // Help an interrupted winning writer before advancing; CAS never replaces a newer head
      await bucket(context).put(headKey, canonical({ version: 1, sequence: next.body.sequence, digest: next.digest }), { onlyIf: { etagMatches: head.etag } })
      context.checkpoint('ledger.head.written')
    }
    fail('LEDGER_CONTENTION')
  })
}

export async function readRevocation(intentId: string, context: ServiceContext): Promise<RevocationEvent | null> {
  return operation(context, async () => {
    parse(OpaqueIdSchema, intentId)
    await rawHead(context)
    if (!await read(eventKey(intentId), RecordSchema, context)) return null
    return covered(intentId, context)
  })
}
export async function readRevocationLiabilities(intentId: string, context: ServiceContext): Promise<readonly ClosedLiabilityPage[] | null> {
  return operation(context, async () => {
    parse(OpaqueIdSchema, intentId)
    await covered(intentId, context)
    const stored = await record(intentId, context)
    return stored.body.manifest ? verifyManifest(stored.body.manifest, context) : null
  })
}
export async function readRevocationHead(context: ServiceContext, minimum?: RevocationHead): Promise<RevocationHead> {
  return operation(context, async () => {
    const current = (await rawHead(context)).body
    if (minimum) {
      const floor = parse(HeadSchema, minimum)
      if (current.sequence < floor.sequence) fail('LEDGER_REGRESSED')
      if (floor.sequence > 0 && (await read(indexKey(floor.sequence), IndexSchema, context))?.digest !== floor.digest) fail('LEDGER_REGRESSED')
    }
    return current
  })
}

const ScanSchema = z.strictObject({
  head: HeadSchema, cursor: z.string().min(1).max(4096), lastKey: z.string().max(256),
  events: uint, claims: uint, indexes: uint, heads: uint, manifests: uint, expectedManifests: uint,
})
export type LedgerScan = z.infer<typeof ScanSchema>
export interface LedgerPage { readonly head: RevocationHead; readonly events: readonly RevocationEvent[]; readonly next: LedgerScan | null }
// A scan is resumable trusted server work, not a client-supplied proof or a D1 reconciliation
// Only the final page with the same head closes list/index coverage; concurrent changes restart it
export async function verifyRevocationLedgerPage(context: ServiceContext, continuation?: LedgerScan, minimum?: RevocationHead): Promise<LedgerPage> {
  return operation(context, async () => {
    if (continuation) parse(ScanSchema, continuation)
    const head = await readRevocationHead(context, minimum)
    if (continuation && canonical(head) !== canonical(continuation.head)) fail('LEDGER_CHANGED')
    const listing = await bucket(context).list({ prefix, limit: ledgerLimits.scanObjects, cursor: continuation?.cursor })
    const counts = continuation ? { ...continuation } : { events: 0, claims: 0, indexes: 0, heads: 0, manifests: 0, expectedManifests: 0, lastKey: '' }
    const events: RevocationEvent[] = []
    for (const item of listing.objects) {
      if (!item.key.startsWith(prefix) || item.key <= counts.lastKey) fail('LEDGER_INCOMPLETE')
      counts.lastKey = item.key
      const suffix = item.key.slice(prefix.length)
      if (suffix === 'head') { counts.heads++; continue }
      if (suffix.startsWith('index/')) {
        counts.indexes++
        const index = await read(item.key, IndexSchema, context)
        if (!index || item.key !== indexKey(index.body.sequence) || index.body.sequence > head.sequence) fail('LEDGER_INCOMPLETE')
        const previous = index.body.sequence === 1 ? null : await read(indexKey(index.body.sequence - 1), IndexSchema, context)
        if (index.body.previousDigest !== (previous?.digest ?? null) || (index.body.sequence > 1 && !previous)) fail('LEDGER_INCOMPLETE')
        await indexCoverage(index.body, context)
      } else if (suffix.startsWith('events/')) {
        counts.events++
        const intent = parse(OpaqueIdSchema, suffix.slice(7), 'LEDGER_CORRUPT')
        events.push(await covered(intent, context))
        const stored = await record(intent, context)
        if (stored.body.manifest) counts.expectedManifests += stored.body.manifest.pageDigests.length + 1
      } else if (suffix.startsWith('claims/')) {
        counts.claims++
        await covered(parse(OpaqueIdSchema, suffix.slice(7), 'LEDGER_CORRUPT'), context)
      } else if (suffix.startsWith('manifests/')) {
        counts.manifests++
        const parts = suffix.split('/')
        const intent = parse(OpaqueIdSchema, parts[1], 'LEDGER_CORRUPT')
        const stored = await record(intent, context)
        if (!stored.body.manifest || parts.length !== 3 || (parts[2] !== 'association' && !stored.body.manifest.pageDigests.some((_, index) => pageKey(intent, index) === item.key))) fail('LEDGER_INCOMPLETE')
        await covered(intent, context)
      } else fail('LEDGER_CORRUPT')
    }
    if (canonical((await rawHead(context)).body) !== canonical(head)) fail('LEDGER_CHANGED')
    if (listing.truncated && (!listing.cursor || listing.cursor === continuation?.cursor || !listing.objects.length)) fail('LEDGER_INCOMPLETE')
    // Exact category counts detect list omissions even when direct GET still finds the missing member
    if (!listing.truncated && (counts.events !== head.sequence || counts.claims !== head.sequence || counts.indexes !== head.sequence || counts.heads !== 1 || counts.manifests !== counts.expectedManifests)) fail('LEDGER_INCOMPLETE')
    return { head, events, next: listing.truncated ? { ...counts, head, cursor: listing.cursor } : null }
  })
}
