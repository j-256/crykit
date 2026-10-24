import { z } from 'zod'
import type { Table } from 'dexie'
import { LegacyCaptureDatabase, compareHeldLegacyBranch, compareLegacyBranch, holdLegacyReaders, type LegacyCapture, type LegacyParticipant, type HeldLegacyReaders, type LegacyComparison } from './legacy-capture'
import { acquireParticipantBarrier, releaseParticipantBarrier, GUEST_BARRIER_KEY } from './guest-barrier'
import { equalLegacyValue } from './legacy-value'
import { withGuestOperationOwner, type GuestOperationOwner } from './guest-ownership'

export const GuestManifestSchema = z.object({ version: z.literal(1), id: z.string().min(1), revision: z.number().int().nonnegative().safe(), planner: z.string().min(1), inspector: z.string().min(1), files: z.string().min(1) }).strict()
export type GuestManifest = z.infer<typeof GuestManifestSchema>
export const GuestManifestV2Schema = GuestManifestSchema.extend({ version: z.literal(2) }).strict()
export type GuestManifestV2 = z.infer<typeof GuestManifestV2Schema>
const GuestManifestRouteSchema = z.discriminatedUnion('version', [GuestManifestSchema, GuestManifestV2Schema])
export function requireGuestRestoreManifest(value: unknown): GuestManifestV2 {
  const manifest = GuestManifestV2Schema.parse(value)
  const prefix = `crykit-restored-v2-${manifest.id}`
  if (manifest.planner !== `${prefix}-planner` || manifest.inspector !== `${prefix}-inspector` || manifest.files !== `${prefix}-files`) throw new Error('Guest restore target identity is invalid')
  return manifest
}
export function requireV1GuestManifest(value: unknown): GuestManifest {
  const parsed = GuestManifestRouteSchema.safeParse(value)
  if (!parsed.success) throw new Error('The local workspace manifest is unsupported or incomplete')
  const manifest = parsed.data
  if (manifest.version === 2) throw new Error('This local workspace version is not available yet')
  return manifest
}
export interface PreparedGuestProfile { readonly id: string; readonly mode: 'additive' | 'replace'; readonly expected: GuestManifest; readonly target: GuestManifest; readonly capture: LegacyCapture }
export interface GuestActivationJournal extends PreparedGuestProfile {
  readonly version: 1
  readonly localStatus: 'prepared' | 'barriers' | 'publishing' | 'published' | 'failed' | 'uncertain' | 'recovering'
  readonly owner?: string
  readonly acquired: readonly string[]
  readonly recovery: 'unchecked' | 'equal' | 'diverged' | 'incomplete'
  readonly observation?: LegacyComparison
}
export interface GuestRestoreJournal {
  readonly version: 2
  readonly kind: 'guest-restore'
  readonly id: string
  readonly expected: GuestManifest | GuestManifestV2
  readonly target: GuestManifestV2
  readonly capture: LegacyCapture
  readonly targetCapture?: LegacyCapture
  readonly phase: 'registered' | 'staging' | 'staged' | 'publishing' | 'published' | 'blocked' | 'recovering'
  readonly ownerGeneration: number
  readonly owner?: string
  readonly sourceVectorDigest: string
  readonly snapshotDigest: string
  readonly acquired: readonly string[]
  readonly recovery: 'unchecked' | 'equal' | 'diverged' | 'incomplete'
}
export interface GuestSuccessorJournal extends Omit<GuestRestoreJournal, 'kind' | 'expected' | 'snapshotDigest'> {
  readonly kind: 'guest-successor'
  readonly expected: GuestManifestV2
  readonly commandId: string
  readonly resultDigest: string
  readonly recoveryCapture?: LegacyCapture
}
export const GUEST_RESTORE_INERT_PHASES: ReadonlySet<GuestRestoreJournal['phase']> = new Set(['registered', 'staging', 'staged', 'blocked'])
const GuestRestoreJournalSchema = z.strictObject({
  version: z.literal(2), kind: z.literal('guest-restore'), id: z.string().uuid(),
  expected: GuestManifestRouteSchema, target: GuestManifestV2Schema,
  capture: z.strictObject({ id: z.string().min(1), version: z.literal(1), completed: z.literal(true), participants: z.array(z.strictObject({ kind: z.enum(['planner', 'inspector', 'files']), name: z.string().min(1), tables: z.array(z.string().min(1)) })) }),
  targetCapture: z.strictObject({ id: z.string().min(1), version: z.literal(1), completed: z.literal(true), participants: z.array(z.strictObject({ kind: z.enum(['planner', 'inspector', 'files']), name: z.string().min(1), tables: z.array(z.string().min(1)) })) }).optional(),
  phase: z.enum(['registered', 'staging', 'staged', 'publishing', 'published', 'blocked', 'recovering']),
  ownerGeneration: z.number().int().nonnegative().safe(), owner: z.string().optional(),
  sourceVectorDigest: z.string().regex(/^[0-9a-f]{64}$/), snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
  acquired: z.array(z.string()), recovery: z.enum(['unchecked', 'equal', 'diverged', 'incomplete']),
})
const GuestSuccessorJournalSchema = GuestRestoreJournalSchema.omit({ kind: true, expected: true, snapshotDigest: true }).extend({
  kind: z.literal('guest-successor'), expected: GuestManifestV2Schema, commandId: z.string().min(1), resultDigest: z.string().regex(/^[0-9a-f]{64}$/),
  recoveryCapture: GuestRestoreJournalSchema.shape.capture.optional(),
})
export function requireGuestRestoreJournal(value: unknown): GuestRestoreJournal {
  const journal = GuestRestoreJournalSchema.parse(value)
  requireGuestRestoreManifest(journal.target)
  if (journal.id !== journal.target.id || journal.target.revision !== journal.expected.revision + 1) throw new Error('Guest restore journal target pairing is invalid')
  if (journal.expected.version === 2) requireGuestRestoreManifest(journal.expected)
  const participants = journal.capture.participants
  if (participants.length !== 3 || participants.map(value => value.kind).join(',') !== 'planner,inspector,files'
    || participants.some(value => value.name !== journal.expected[value.kind] || new Set(value.tables).size !== value.tables.length)) throw new Error('Guest restore journal source association is invalid')
  const targetParticipants = journal.targetCapture?.participants
  if (targetParticipants && (targetParticipants.length !== 3 || targetParticipants.map(value => value.kind).join(',') !== 'planner,inspector,files'
    || targetParticipants.some(value => value.name !== journal.target[value.kind] || new Set(value.tables).size !== value.tables.length))) throw new Error('Guest restore journal target capture association is invalid')
  if (['staged', 'publishing', 'published'].includes(journal.phase) && !journal.targetCapture) throw new Error('Guest restore journal lacks a complete target capture')
  return journal
}
export function requireGuestSuccessorJournal(value: unknown): GuestSuccessorJournal {
  const journal = GuestSuccessorJournalSchema.parse(value)
  requireGuestRestoreManifest(journal.expected)
  requireGuestRestoreManifest(journal.target)
  if (journal.id !== journal.target.id || journal.expected.id === journal.target.id || journal.target.revision !== journal.expected.revision + 1) throw new Error('Guest successor manifest pairing is invalid')
  const source = journal.capture.participants, target = journal.targetCapture?.participants
  if (source.length !== 3 || source.map(value => value.kind).join(',') !== 'planner,inspector,files'
    || source.some(value => value.name !== journal.expected[value.kind] || new Set(value.tables).size !== value.tables.length)) throw new Error('Guest successor source capture is invalid')
  if (target && (target.length !== 3 || target.map(value => value.kind).join(',') !== 'planner,inspector,files'
    || target.some(value => value.name !== journal.target[value.kind] || new Set(value.tables).size !== value.tables.length))) throw new Error('Guest successor target capture is invalid')
  if (['staged', 'publishing', 'published'].includes(journal.phase) && !target) throw new Error('Guest successor target capture is incomplete')
  const recovery = journal.recoveryCapture?.participants
  if (recovery && (recovery.length !== 3 || recovery.map(value => value.kind).join(',') !== 'planner,inspector,files'
    || recovery.some(value => new Set(value.tables).size !== value.tables.length))) throw new Error('Guest successor recovery capture is invalid')
  return journal
}
export function requireGuestPublicationJournal(value: unknown): GuestRestoreJournal | GuestSuccessorJournal {
  if (!value || typeof value !== 'object') throw new Error('Guest publication journal is unavailable')
  return (value as { kind?: unknown }).kind === 'guest-successor' ? requireGuestSuccessorJournal(value) : requireGuestRestoreJournal(value)
}
const V1GuestJournalShape = z.object({
  version: z.literal(1), id: z.string().min(1), mode: z.enum(['additive', 'replace']),
  expected: GuestManifestSchema, target: GuestManifestSchema,
  capture: z.object({ id: z.string().min(1), version: z.literal(1), completed: z.literal(true), participants: z.array(z.object({ kind: z.enum(['planner', 'inspector', 'files']), name: z.string().min(1), tables: z.array(z.string().min(1)) }).passthrough()) }).passthrough(),
  localStatus: z.enum(['prepared', 'barriers', 'publishing', 'published', 'failed', 'uncertain', 'recovering']),
  owner: z.string().optional(), acquired: z.array(z.string()), recovery: z.enum(['unchecked', 'equal', 'diverged', 'incomplete']),
}).passthrough()
function assertV1GuestJournalRoute(value: unknown): asserts value is GuestActivationJournal {
  if (!value || typeof value !== 'object') throw new Error('Guest activation journal is unavailable')
  const row = value as Record<string, unknown>
  // A v2 row may carry v1-looking participant names; never let the v1 scanner open them
  if (row.version !== 1 || 'kind' in row) throw new Error('This local workspace journal version is not available yet')
}
export function requireV1GuestJournal(value: unknown): GuestActivationJournal {
  assertV1GuestJournalRoute(value)
  const parsed = V1GuestJournalShape.safeParse(value)
  if (!parsed.success) throw new Error('Guest activation journal is incomplete')
  const { expected, target, capture } = parsed.data
  if (expected.id === target.id || target.revision !== expected.revision + 1) throw new Error('Guest activation journal has an invalid v1 participant pairing')
  const recorded = new Map(capture.participants.map(participant => [participant.kind, participant.name]))
  if (capture.participants.length !== 3 || recorded.size !== 3 || recorded.get('planner') !== expected.planner || recorded.get('inspector') !== expected.inspector || recorded.get('files') !== expected.files) throw new Error('Guest activation journal has an invalid v1 participant pairing')
  return value as GuestActivationJournal
}
export class GuestCoordinatorDatabase extends LegacyCaptureDatabase {
  active!: Table<{ key: 'active'; manifest: GuestManifest }, string>
  journal!: Table<GuestActivationJournal, string>
  constructor(name = 'crykit-guest-coordinator-v1') { super(name); this.version(2).stores({ active: 'key', journal: 'id' }); this.version(3).stores({ managedRecords: 'revisionId,operationId', managedChunks: '[revisionId+index],revisionId', managedOperations: 'id', managedMigrations: 'id' }) }
}
function ordered(participants: readonly LegacyParticipant[]): readonly LegacyParticipant[] {
  const order = ['planner', 'inspector', 'files']
  if (new Set(participants.map(participant => participant.kind)).size !== participants.length) throw new Error('Duplicate guest participant')
  return [...participants].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
}

async function ownedJournalUpdate(database: GuestCoordinatorDatabase, owner: GuestOperationOwner, previous: GuestActivationJournal, next: GuestActivationJournal): Promise<void> {
  await database.transaction('rw', database.active, database.journal, async () => {
    owner.assertAlive()
    const actual = await database.journal.get(previous.id)
    if (!actual || !equalLegacyValue(actual, previous)) throw new Error('Guest operation journal ownership changed')
    await database.journal.put(next)
    owner.assertAlive()
  })
}

export function reconcileGuestOperation(database: GuestCoordinatorDatabase, id: string, participants: readonly LegacyParticipant[], signal?: AbortSignal): Promise<GuestActivationJournal> {
  return withGuestOperationOwner(database, signal, owner => reconcileOwned(database, owner, id, participants, owner.signal))
}

async function reconcileOwned(database: GuestCoordinatorDatabase, owner: GuestOperationOwner, id: string, participants: readonly LegacyParticipant[], signal?: AbortSignal): Promise<GuestActivationJournal> {
  // Claim a durable fencing token before any source inspection or rollback decision
  // A delayed callback from an owner whose native transaction died can no longer publish
  const { journal, actual, history } = await database.transaction('rw', database.active, database.journal, async () => {
    owner.assertAlive()
    const previous = await database.journal.get(id), actual = await database.active.get('active')
    if (!previous || !actual) throw new Error('Guest activation journal is unavailable')
    const admitted = requireV1GuestJournal(previous)
    requireV1GuestManifest(actual.manifest)
    const history = await database.journal.toArray()
    // Reject unsupported routes without reinterpreting unrelated frozen v1 observations
    for (const row of history) {
      if ((row as { version?: number }).version === 2) {
        const candidate = requireGuestPublicationJournal(row)
        if (!GUEST_RESTORE_INERT_PHASES.has(candidate.phase)) throw new Error('The guest restore requires its v2 recovery route')
      } else assertV1GuestJournalRoute(row)
    }
    const journal = { ...admitted, owner: owner.id }
    await database.journal.put(journal)
    owner.assertAlive()
    return { journal, actual, history }
  })
  let descended = equalLegacyValue(actual.manifest, journal.target)
  if (!descended && journal.localStatus === 'published') {
    const seen = new Set<string>()
    let cursor = actual.manifest
    while (!seen.has(cursor.id)) {
      seen.add(cursor.id)
      const previous = history.find(value => value.localStatus === 'published' && equalLegacyValue(value.target, cursor) && value.target.revision === value.expected.revision + 1)
      if (!previous) break
      cursor = requireV1GuestManifest(previous.expected)
      if (equalLegacyValue(cursor, journal.target)) { descended = true; break }
    }
  }
  if (descended) {
    const observation = await compareLegacyBranch(database, journal.capture, ordered(participants).map(participant => ({ ...participant, barrierOwner: id })), signal)
    const next: GuestActivationJournal = { ...journal, localStatus: 'published', recovery: observation.status, observation }
    await ownedJournalUpdate(database, owner, journal, next)
    return next
  }
  if (!equalLegacyValue(actual.manifest, journal.expected)) {
    const next: GuestActivationJournal = { ...journal, localStatus: 'uncertain', recovery: 'incomplete' }
    await ownedJournalUpdate(database, owner, journal, next); return next
  }
  const recovering: GuestActivationJournal = { ...journal, localStatus: 'recovering', recovery: 'incomplete' }
  await ownedJournalUpdate(database, owner, journal, recovering)
  // Exclusive live ownership plus the durable recovering phase excludes publication during release
  // A crash between releases is replayed idempotently by the next owner
  for (const participant of [...ordered(participants)].reverse()) {
    owner.assertAlive()
    const barrier = await participant.database.table('meta').get(GUEST_BARRIER_KEY) as { value?: unknown } | undefined
    owner.assertAlive()
    if (barrier) {
      if (barrier.value !== id || Object.keys(barrier).sort().join(',') !== 'key,value') throw new Error('A different operation owns the retained barrier')
      await releaseParticipantBarrier(participant.database, id)
      owner.assertAlive()
    }
  }
  const next: GuestActivationJournal = { ...recovering, localStatus: 'failed', recovery: 'unchecked' }
  await ownedJournalUpdate(database, owner, recovering, next)
  return next
}

export async function activateGuestProfile(database: GuestCoordinatorDatabase, prepared: PreparedGuestProfile, participants: readonly LegacyParticipant[], signal?: AbortSignal, assertMayActivate: () => void = () => {}): Promise<GuestManifest> {
  return withGuestOperationOwner(database, signal, owner => activateOwned(database, owner, prepared, participants, owner.signal, assertMayActivate))
}

async function activateOwned(database: GuestCoordinatorDatabase, owner: GuestOperationOwner, prepared: PreparedGuestProfile, participants: readonly LegacyParticipant[], signal: AbortSignal | undefined, assertMayActivate: () => void): Promise<GuestManifest> {
  GuestManifestSchema.parse(prepared.expected); GuestManifestSchema.parse(prepared.target)
  if (prepared.expected.id === prepared.target.id || prepared.target.revision !== prepared.expected.revision + 1 || !prepared.capture.completed) throw new Error('Invalid prepared guest activation')
  const selected = ordered(participants)
  if (selected.length !== 3 || selected.some(participant => participant.database.name !== prepared.expected[participant.kind])) throw new Error('The complete captured guest participant vector is required')
  if (new Set([prepared.target.planner, prepared.target.inspector, prepared.target.files]).size !== 3 || selected.some(participant => participant.database.name === prepared.target[participant.kind])) throw new Error('Guest activation requires separate prepared containers')
  let held: HeldLegacyReaders | undefined
  let journal: GuestActivationJournal = { ...prepared, version: 1, owner: owner.id, localStatus: 'prepared', acquired: [], recovery: 'unchecked' }
  owner.assertAlive(); assertMayActivate()
  const active = await database.active.get('active')
  if (!active || !equalLegacyValue(requireV1GuestManifest(active.manifest), prepared.expected)) throw new Error('The active local workspace changed during preparation')
  await database.journal.add(journal)
  try {
    for (const participant of selected) {
      if (signal?.aborted) throw new Error('Guest activation cancelled')
      owner.assertAlive()
      await acquireParticipantBarrier(participant.database, prepared.id)
      const next: GuestActivationJournal = { ...journal, localStatus: 'barriers', acquired: [...journal.acquired, participant.database.name] }
      await ownedJournalUpdate(database, owner, journal, next); journal = next
    }
    held = await holdLegacyReaders(selected.map(participant => ({ ...participant, barrierOwner: prepared.id })), signal)
    if (!await compareHeldLegacyBranch(database, prepared.capture, held)) throw new Error('The previous local workspace changed during preparation. Keep the prepared copy and retry.')
    const publishing: GuestActivationJournal = { ...journal, localStatus: 'publishing' }
    await ownedJournalUpdate(database, owner, journal, publishing); journal = publishing
    held.assertAlive()
    await database.transaction('rw', database.active, database.journal, async () => {
      owner.assertAlive(); held!.assertAlive()
      const owned = await database.journal.get(prepared.id)
      if (!owned || !equalLegacyValue(owned, journal) || owned.owner !== owner.id || owned.localStatus !== 'publishing') throw new Error('Guest publication ownership changed')
      const actual = await database.active.get('active')
      if (!actual || !equalLegacyValue(actual.manifest, prepared.expected)) throw new Error('The active local workspace changed during preparation')
      // UI draft/profile authority can change while staging or waiting for the pointer transaction
      assertMayActivate()
      await database.active.put({ key: 'active', manifest: prepared.target })
      await database.journal.put({ ...journal, localStatus: 'published', recovery: 'unchecked' })
      owner.assertAlive(); held!.assertAlive()
      assertMayActivate()
    })
    // Source readers and the pointer transaction have separate outcomes; never infer common rollback
    held.assertAlive()
    await held.release()
    return prepared.target
  } catch (error) {
    await held?.release(true)
    // Read the actual durable pointer before deciding whether owned barriers can be released
    // A committed successor remains active even when the last source observation became uncertain
    owner.assertAlive()
    const actual = await database.active.get('active')
    if (actual && equalLegacyValue(actual.manifest, prepared.target)) {
      const published = await database.journal.get(prepared.id)
      if (!published || published.owner !== owner.id || published.localStatus !== 'published') throw new Error('Guest publication ownership changed')
      await ownedJournalUpdate(database, owner, published, { ...published, recovery: 'incomplete' })
    } else await reconcileOwned(database, owner, prepared.id, selected, signal)
    throw error
  }
}
