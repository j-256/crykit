import type { Knowledge, PartyProgressRecord, Playthrough, ProgressStage } from '../../domain/types'
import { privateRecordKey, type WorkspaceDocument, type WorkspaceDocumentKind } from '../../workspace/documents'

export interface ConflictSummaryField { readonly label: string; readonly value: string }
export interface ConflictRecordSummary { readonly title: string; readonly fields: readonly ConflictSummaryField[] }
const stageNames: Record<ProgressStage, string> = { notAcquired: 'Not acquired', unlocked: 'Unlocked', mastered: 'Mastered', sealAcquired: 'Seal acquired' }
const displayValue = (value: string | boolean) => typeof value === 'boolean' ? value ? 'Yes' : 'No' : value
function knowledge<Value extends string | boolean>(value: Knowledge<Value>, display: (value: Value) => string = displayValue): string {
  if (value.state === 'known') return display(value.value)
  if (value.state === 'conflicting') return `Conflicting: ${value.claims.map(claim => display(claim.value)).join('; ')}`
  const label = value.state === 'notApplicable' ? 'Not applicable' : 'Unknown'
  return value.reason ? `${label}: ${value.reason}` : label
}

// These are display summaries of admitted closure bodies, never substitutes for the complete saved version
// Names describe each branch independently and cannot establish matching record or Playthrough identity
export function conflictRecordSummary(kind: WorkspaceDocumentKind, value: unknown, key: string, documents: readonly WorkspaceDocument[]): ConflictRecordSummary | undefined {
  if (kind === 'progress') {
    const record = value as PartyProgressRecord
    const ownerKey = privateRecordKey('playthrough', (JSON.parse(key) as string[])[1])
    const owner = documents.find(document => document.kind === 'playthrough' && document.key === ownerKey)?.value as unknown as { metadata: Playthrough } | undefined
    return { title: record.displayName ? `Progress: ${record.displayName}` : 'Progress record', fields: [
      { label: 'Playthrough', value: owner ? owner.metadata.label || 'Unnamed Playthrough' : 'Unavailable in this saved version' },
      { label: 'Record', value: record.displayName || 'Unnamed Progress record' },
      { label: 'Stage', value: knowledge(record.stage, stage => stageNames[stage]) },
      { label: 'Unlocked', value: knowledge(record.unlocked) },
      { label: 'Party mastery', value: knowledge(record.partyMastery) },
      { label: 'Collected', value: knowledge(record.collection) },
      { label: 'Master location', value: knowledge(record.masterLocation) },
      { label: 'Observed', value: record.observedAt ?? 'Not recorded' },
      { label: 'Updated', value: record.updatedAt },
      { label: 'Record sources', value: record.sources.length ? `${record.sources.length} recorded` : 'None recorded' },
    ] }
  }
  if (kind === 'playthrough') {
    const { metadata } = value as { metadata: Playthrough }
    return { title: 'Playthrough details', fields: [
      { label: 'Name', value: metadata.label || 'Unnamed Playthrough' },
      { label: 'Created', value: metadata.createdAt },
      { label: 'Updated', value: metadata.updatedAt },
      { label: 'Saved revision', value: String(metadata.revision) },
    ] }
  }
  return undefined
}
