import type { CapturedRecordReader, CapturedWorkspaceRecord } from '../../workspace/account-evidence'
import { recordedPartyFloor } from '../../workspace/source-bookkeeping'
import { SyncError } from './client'

// Callers supply only final selected scenarios; retained conflict branches must not advance live clocks
// This clock check does not replace captured closure and checkpoint validation by the caller
export async function projectionBookkeeping(scenarios: readonly CapturedWorkspaceRecord[], readCaptured: CapturedRecordReader, updatedAt: string): Promise<Map<string, { revision: number; updatedAt: string }>> {
  const bookkeeping = new Map<string, { revision: number; updatedAt: string }>()
  for (const original of scenarios) {
    if (original.document.kind !== 'scenario') throw new SyncError('INTEGRITY_FAILED')
    const ownerId = (JSON.parse(original.document.key) as string[])[1], ownerKey = JSON.stringify(['playthrough', ownerId])
    const value = original.document.value as unknown as { baseline: { kind: string } }
    if (value.baseline.kind !== 'recordedParty') { if (original.sourceBookkeeping) throw new SyncError('INTEGRITY_FAILED'); continue }
    const owners = await Promise.all(original.dependencies.map(readCaptured))
    // Source evidence may name a historical owner, not the selected live owner with the same private key
    const owner = original.sourceBookkeeping ? await readCaptured(original.sourceBookkeeping.owner) : owners.find(value => value.document.key === ownerKey)
    if (!owner) throw new SyncError('INTEGRITY_FAILED')
    const floor = recordedPartyFloor(original, owner, original.sourceBookkeeping)
    const current = bookkeeping.get(ownerId)
    // Only an authenticated baseline creates a causal floor; source counters and timestamps are not merged
    if (!current || floor > current.revision) bookkeeping.set(ownerId, { revision: floor, updatedAt })
  }
  return bookkeeping
}
