import { useState } from 'react'
import { AdminAuditActionSchema } from '../../account/admin-protocol'
import type { AdminClient } from './admin-client'
import {
  ObservationNote,
  time,
  type ActionOpener,
  type AuditRow,
  type OperatorRow,
  type Page,
} from './admin-view'
import { DataState, useAdminData } from './useAdminData'
import { PageControls, useActionRefresh, usePage } from './admin-components'
import { StatusBadge } from './admin-help'

export default function AdminAccess({
  client,
  role,
  openAction,
  newId,
  refreshKey = 0,
}: {
  client: AdminClient
  role: 'owner' | 'administrator'
  openAction: ActionOpener
  newId(): string
  refreshKey?: number
}) {
  const [email, setEmail] = useState('')
  const [invitationId, setInvitationId] = useState('')
  const [invitationRevision, setInvitationRevision] = useState('1')
  const [action, setAction] = useState('')
  const [outcome, setOutcome] = useState('')
  const auditNav = usePage()
  const operatorNav = usePage()
  const auditPage = useAdminData<Page<AuditRow>>(
    client,
    `audit?limit=50&order=desc${action ? `&action=${encodeURIComponent(action)}` : ''}${outcome ? `&outcome=${outcome}` : ''}${auditNav.cursor ? `&cursor=${encodeURIComponent(auditNav.cursor)}` : ''}`,
  )
  const operatorPage = useAdminData<Page<OperatorRow>>(
    client,
    `operators?limit=50&order=desc${operatorNav.cursor ? `&cursor=${encodeURIComponent(operatorNav.cursor)}` : ''}`,
  )
  useActionRefresh(refreshKey, auditPage.refresh)
  useActionRefresh(refreshKey, operatorPage.refresh)
  return (
    <section>
      <h1 tabIndex={-1}>Audit and access</h1>
      <p>
        Action history retains opaque identifiers and diagnostic codes. Membership is separate from
        customer sign-in.
      </p>
      <h2>Operators</h2>
      <DataState
        loading={operatorPage.loading}
        error={operatorPage.error}
        empty={!!operatorPage.value && !operatorPage.value.items.length}
      />
      {operatorPage.value && !operatorPage.loading && (
        <>
          <ObservationNote value={operatorPage.value} />
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Operator</th>
                  <th>Role</th>
                  <th>State</th>
                  <th>Joined</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {operatorPage.value.items.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Operator">
                      <span className="admin-id">{row.id}</span>
                      <small>{row.email}</small>
                    </td>
                    <td data-label="Role">{row.role}</td>
                    <td data-label="State">
                      <StatusBadge value={row.state} />
                    </td>
                    <td data-label="Joined">{time(row.created_at)}</td>
                    <td data-label="Action">
                      {role === 'owner' &&
                        row.role === 'administrator' &&
                        row.state === 'active' && (
                          <button
                            type="button"
                            onClick={(event) =>
                              openAction(
                                event.currentTarget,
                                { kind: 'operator', id: row.id },
                                row.revision,
                                { type: 'operators.remove' },
                                'security',
                              )
                            }
                          >
                            Preview removal
                          </button>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PageControls
            page={operatorPage.value}
            index={operatorNav.index}
            previous={operatorNav.previous}
            next={operatorNav.next}
            reset={operatorNav.reset}
            noun="operators"
          />
        </>
      )}
      {role === 'owner' && (
        <section className="admin-detail admin-access-panel">
          <h2>Invite an administrator</h2>
          <p>
            First allow the invitee's verified email through the admin Cloudflare Access policy.
            This panel cannot change that policy. The invitation alone grants no access.
          </p>
          <form
            className="admin-access-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (email)
                openAction(
                  (event.nativeEvent as SubmitEvent).submitter,
                  { kind: 'invitation', id: newId() },
                  0,
                  { type: 'operators.invite', email, role: 'administrator' },
                  'operations',
                )
            }}
          >
            <label>
              Verified email{' '}
              <input
                type="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button type="submit">Preview invitation</button>
          </form>
          <h3>Cancel a known invitation</h3>
          <p>
            Enter an invitation ID from its invitation audit entry or saved action. Acceptance state
            is checked by the server preview.
          </p>
          <form
            className="admin-access-form admin-access-form--cancel"
            onSubmit={(event) => {
              event.preventDefault()
              if (invitationId && Number.isSafeInteger(Number(invitationRevision)))
                openAction(
                  (event.nativeEvent as SubmitEvent).submitter,
                  { kind: 'invitation', id: invitationId },
                  Number(invitationRevision),
                  { type: 'operators.invitation.cancel' },
                  'operations',
                )
            }}
          >
            <label>
              Invitation ID{' '}
              <input
                required
                value={invitationId}
                onChange={(event) => setInvitationId(event.target.value)}
              />
            </label>
            <label>
              Revision{' '}
              <input
                type="number"
                min="1"
                step="1"
                required
                value={invitationRevision}
                onChange={(event) => setInvitationRevision(event.target.value)}
              />
            </label>
            <button type="submit">Preview cancellation</button>
          </form>
        </section>
      )}
      <h2>Audit history</h2>
      <p>
        Audit records are retained for 90 days. Results show the observed page, with newest entries
        first.
      </p>
      <div className="admin-search">
        <label>
          Action{' '}
          <select
            value={action}
            onChange={(event) => {
              setAction(event.target.value)
              auditNav.reset()
            }}
          >
            <option value="">All actions</option>
            {AdminAuditActionSchema.options.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Outcome{' '}
          <select
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value)
              auditNav.reset()
            }}
          >
            <option value="">All outcomes</option>
            {['complete', 'queued', 'denied', 'read'].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            setAction('')
            setOutcome('')
            auditNav.reset()
          }}
        >
          Reset filters
        </button>
        <button type="button" onClick={() => void auditPage.refresh()}>
          Refresh audit
        </button>
      </div>
      <DataState
        loading={auditPage.loading}
        error={auditPage.error}
        empty={!!auditPage.value && !auditPage.value.items.length}
      />
      {auditPage.value && !auditPage.loading && (
        <>
          <ObservationNote value={auditPage.value} />
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action and outcome</th>
                  <th>Target</th>
                  <th>Context</th>
                </tr>
              </thead>
              <tbody>
                {auditPage.value.items.map((row) => (
                  <tr key={row.id}>
                    <td data-label="When">{time(row.created_at)}</td>
                    <td data-label="Action and outcome">
                      <strong>{row.action}</strong>
                      <small>{row.outcome}</small>
                    </td>
                    <td data-label="Target">
                      {row.target_kind} <span className="admin-id">{row.target_id}</span>
                    </td>
                    <td data-label="Context">
                      <span className="admin-id">Request {row.request_id}</span>
                      <small className="admin-id">Actor {row.actor_id}</small>
                      {row.action_id && <small className="admin-id">Action {row.action_id}</small>}
                      {row.reason && <small>Reason {row.reason}</small>}
                      {row.case_id && <small>Case {row.case_id}</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PageControls
            page={auditPage.value}
            index={auditNav.index}
            previous={auditNav.previous}
            next={auditNav.next}
            reset={auditNav.reset}
            noun="audit records"
          />
        </>
      )}
    </section>
  )
}
