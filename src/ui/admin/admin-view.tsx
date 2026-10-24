import type { AdminCommand, AdminCommandPayload } from '../../account/admin-protocol'

export interface Observation { observedAt: number; source: 'application-database'; freshness: 'request-read'; offlineOutboxes: 'unobserved'; providerHeadroom: 'unknown' }
export interface Page<T> extends Observation { items: T[]; next: string | null; limit: number }
export interface AccountRow { id: string; email: string; username: string; access: string; revision: number; username_withheld: 0 | 1; capacity_bytes: number; verified_at: number | null; created_at: number }
export interface AccountDetail extends AccountRow, Observation { storage: { payload_bytes: number; reserved_metadata: number; metadata_bytes: number; metadata_rows: number } | null; counts: { objects: number; revisions: number; shares: number } | null; sessions: { id: string; device_id: string; authenticated_at: number; idle_expires_at: number; absolute_expires_at: number; revoked_at: number | null }[]; sessionsTruncated: boolean }
export interface ShareRow { id: string; account_id: string; revision: number; state: string; created_at: number; updated_at: number }
export interface JobRow { id: string; type: string; phase: string; account_id: string | null; revision: number; attempts: number; next_at: number; outcome: string; code: string | null; request_id: string; created_at: number }
export interface OperatorRow { id: string; email: string; role: 'owner' | 'administrator'; state: string; revision: number; created_at: number }
export interface AuditRow { id: string; actor_id: string; action: string; target_kind: string; target_id: string; action_id: string | null; reason: string | null; case_id: string | null; outcome: string; request_id: string; created_at: number }
export interface Settings extends Observation { revision: number; registrationPaused: boolean; uploadsPaused: boolean; sharingPaused: boolean; emailPaused: boolean; maxAccountBytes: number; projectCapacityBytes: number; deploymentCapacity: number }
export type ActionOpener = (trigger: HTMLElement | null, target: AdminCommand['target'], revision: number, command: AdminCommandPayload, reason: AdminCommand['reason'], caseId?: string) => void
export const size = (value: number | null | undefined) => typeof value === 'number' ? `${value.toLocaleString()} bytes` : 'Unavailable'
export const time = (value: number | null | undefined) => typeof value === 'number' && value > 0 ? new Date(value).toLocaleString() : 'Unavailable'
export function ObservationNote({ value }: { value: Observation }) {
  return <p className="admin-observation">Application database · Request read {time(value.observedAt)}. Provider headroom unknown. Offline device outboxes unobserved.</p>
}
