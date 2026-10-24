import Dexie from 'dexie'
import { GuestManagedManifestSchema, requireGuestManagedMigration, requireGuestManagedRecoveryReceipt, type GuestManagedManifest } from './guest-managed-contract'
import { requireGuestPublicationJournal, requireV1GuestJournal } from './guest-coordinator'
import { compareLegacyBranch, type LegacyCapture, type LegacyCaptureDatabase, type LegacyParticipant, type LegacyCaptureRecord } from './legacy-capture'
import { equalLegacyValue } from './legacy-value'
import { guestPlannerValuesEqual } from '../persistence/guest-planner-equality'
import type { GuestRecoveryNotice } from './guest-recovery'

export class RetainedGuestSelectionChanged extends Error { constructor() { super('Retained guest selection changed') } }

export interface RetainedBranch { readonly id: string; readonly original: LegacyCapture; readonly capture: LegacyCapture }

// Dynamic Dexie opening requires an existing schema and never creates or upgrades retired participant stores
// The worker only receives guest coordinator identity; retained byte values never cross its message boundary
export async function compareManagedGuestRetained(databaseName: string, manifest: GuestManagedManifest, signal: AbortSignal): Promise<readonly GuestRecoveryNotice[]> {
  const database = new Dexie(databaseName)
  const check = async () => {
    if (signal.aborted) throw new Error('Retained guest comparison cancelled')
    const selected = GuestManagedManifestSchema.parse((await database.table('active').get('active'))?.manifest)
    // Ordinary heads may advance in this same lineage; replacement/profile changes cannot adopt this result
    if (selected.id !== manifest.id || selected.recoveryId !== manifest.recoveryId) throw new RetainedGuestSelectionChanged()
    if (signal.aborted) throw new Error('Retained guest comparison cancelled')
  }
  try {
    await database.open(); await check()
    const retained = await readManagedRetainedBranches(database, manifest)
    const branches = retained.branches
    const frozen = Object.assign(database, { captures: database.table<LegacyCapture, string>('captures'), records: database.table<LegacyCaptureRecord, [string, number]>('records') }) as LegacyCaptureDatabase
    const notices: GuestRecoveryNotice[] = []
    for (const branch of branches) {
      await check()
      // Restore journals validate descriptor field associations independently of property order
      // The comparison below still checks every original native row and encoded token byte exactly
      if (!guestPlannerValuesEqual(await frozen.captures.get(branch.capture.id), branch.capture)) throw new Error('Retained guest capture changed')
      const opened: Dexie[] = []
      try {
        const participants: LegacyParticipant[] = []
        for (const captured of branch.capture.participants) {
          const participant = new Dexie(captured.name); opened.push(participant)
          await participant.open(); await check()
          if (!equalLegacyValue([...participant.backendDB().objectStoreNames].sort(), [...captured.tables].sort())) throw new Error('Retained guest layout changed')
          participants.push({ kind: captured.kind, database: participant, ...(captured.tables.includes('meta') ? { barrierOwner: branch.id } : {}) })
        }
        const result = await compareLegacyBranch(frozen, branch.capture, participants, signal)
        await check()
        if (result.status !== 'equal') notices.push({ id: branch.id, status: result.status, frozenCaptureId: branch.capture.id })
      } catch (error) {
        if (signal.aborted) throw error
        notices.push({ id: branch.id, status: 'incomplete', frozenCaptureId: branch.capture.id })
      } finally { for (const participant of opened) participant.close() }
    }
    await check()
    await retained.assertUnchanged()
    return notices
  } finally { database.close() }
}

// Only published receipt links may supersede a chosen branch baseline; capture recency grants no authority
export async function readManagedRetainedBranches(database: Dexie, manifest: GuestManagedManifest) {
  const rows: { table: string; key: string; value: unknown }[] = []
  const read = async (table: string, key: string) => { const value: unknown = await database.table(table).get(key); rows.push({ table, key, value }); return value }
  const migrationRow = await read('managedMigrations', manifest.id)
  const branches: RetainedBranch[] = []
  if (!migrationRow) {
    const origin = await read('managedOperations', manifest.id) as { version?: number; id?: string; kind?: string; expected?: unknown; target?: GuestManagedManifest } | undefined
    if (!origin || origin.version !== 1 || origin.id !== manifest.id || origin.kind !== 'managed-local-commit' || origin.expected !== undefined || origin.target?.id !== manifest.id || origin.target.revision !== 0 || origin.target.recoveryId !== undefined) throw new Error('The managed guest has no admitted origin')
    GuestManagedManifestSchema.parse(origin.target)
  } else {
    const migration = requireGuestManagedMigration(migrationRow)
    if (migration.phase !== 'published' || migration.target?.id !== manifest.id || migration.target.recoveryId !== undefined) throw new Error('Managed migration is not published')
    const receipt = await read('managedOperations', migration.id) as { expected?: unknown; target?: unknown } | undefined
    if (!receipt || !equalLegacyValue(receipt.expected, migration.expected) || !equalLegacyValue(receipt.target, migration.target)) throw new Error('Managed migration receipt changed')
    branches.push({ id: migration.id, original: migration.capture, capture: migration.capture })
    let cursor = migration.expected
    const seen = new Set<string>()
    for (;;) {
      if (seen.has(cursor.id)) throw new Error('Retained guest ancestry is cyclic')
      seen.add(cursor.id)
      const prior = await read('journal', cursor.id)
      if (!prior) { if (cursor.version === 2) throw new Error('Retained guest publication is unavailable'); break }
      const admitted = cursor.version === 2 ? requireGuestPublicationJournal(prior) : requireV1GuestJournal(prior)
      const journal = prior as typeof admitted
      if (!equalLegacyValue(journal.target, cursor) || (journal.version === 2 ? journal.phase !== 'published' : journal.localStatus !== 'published')) throw new Error('Retained guest ancestry changed')
      branches.push({ id: journal.id, original: journal.capture, capture: journal.capture })
      cursor = journal.expected
    }
  }
  const original = new Map(branches.map(branch => [branch.id, branch]))
  const recoveries: ReturnType<typeof requireGuestManagedRecoveryReceipt>[] = []
  const seen = new Set<string>()
  let id = manifest.recoveryId, selection = manifest
  while (id) {
    if (seen.has(id)) throw new Error('Managed recovery ancestry is cyclic')
    seen.add(id)
    const receipt = requireGuestManagedRecoveryReceipt(await read('managedOperations', id))
    const branch = original.get(receipt.recovery.branchId)
    if (receipt.id !== id || receipt.target.id !== manifest.id || receipt.target.revision > selection.revision || receipt.target.revision === selection.revision && !guestPlannerValuesEqual(receipt.target, selection) || !branch || receipt.recovery.originalCaptureId !== branch.original.id
      || !guestPlannerValuesEqual(receipt.recovery.capture.participants, branch.original.participants)) throw new Error('Managed recovery belongs to another branch or selection')
    recoveries.push(receipt)
    id = receipt.expected.recoveryId; selection = receipt.expected
  }
  for (const receipt of recoveries.reverse()) {
    const branch = original.get(receipt.recovery.branchId)!
    if (receipt.recovery.previousCaptureId !== branch.capture.id) throw new Error('Managed recovery baseline continuity changed')
    const replacement = { ...branch, capture: receipt.recovery.capture }
    original.set(branch.id, replacement)
  }
  const selected = branches.map(branch => original.get(branch.id)!)
  for (const branch of selected) for (const capture of branch.capture === branch.original ? [branch.original] : [branch.original, branch.capture]) {
    if (!guestPlannerValuesEqual(await read('captures', capture.id), capture)) throw new Error('Retained guest capture changed')
  }
  return { branches: selected, async assertUnchanged() {
    for (const row of rows) if (!equalLegacyValue(await database.table(row.table).get(row.key), row.value)) throw new Error('Retained recovery authority changed during comparison')
  } }
}
