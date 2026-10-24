import { useEffect, useLayoutEffect, useState } from 'react'
import type { AdminClient } from './admin-client'
import {
  ObservationNote,
  size,
  time,
  type AccountDetail,
  type AccountRow,
  type ActionOpener,
  type Page,
} from './admin-view'
import { DataState, useAdminData } from './useAdminData'
import {
  CapacityMeter,
  PageControls,
  useActionRefresh,
  useAdminDetail,
  usePage,
} from './admin-components'
import { accountedBytes, parseUnitBytesDetailed } from './admin-math'
import { AdminHelp, StatusBadge } from './admin-help'
import { routeHash } from './admin-route'

export default function AdminAccounts({
  client,
  openAction,
  role,
  routeTarget = null,
  refreshKey = 0,
}: {
  client: AdminClient
  openAction: ActionOpener
  role: 'owner' | 'administrator'
  routeTarget?: string | null
  refreshKey?: number
}) {
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<'email' | 'username' | 'accountId'>('email')
  const [filter, setFilter] = useState('')
  const page = usePage()
  const [selected, setSelected] = useState<string | null>(routeTarget)
  useEffect(() => {
    setSelected(routeTarget)
  }, [routeTarget])
  const {
    value: detail,
    error: detailError,
    loading: detailLoading,
    refresh: refreshDetail,
  } = useAdminDetail<AccountDetail>(client, 'accounts', selected, refreshKey)
  const [policy, setPolicy] = useState<'active' | 'read-only' | 'blocked'>('read-only')
  const [quota, setQuota] = useState('')
  const [reason, setReason] = useState<'support' | 'security' | 'abuse' | 'user-request'>('support')
  const [selectedSessions, setSelectedSessions] = useState<string[]>([])
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [access, setAccess] = useState('')
  const path = `accounts?limit=50&order=desc${filter ? `&${kind}=${encodeURIComponent(filter)}` : ''}${access ? `&access=${access}` : ''}${page.cursor ? `&cursor=${encodeURIComponent(page.cursor)}` : ''}`
  const { value, loading, error, refresh } = useAdminData<Page<AccountRow>>(client, path)
  useActionRefresh(refreshKey, refresh)
  useLayoutEffect(() => {
    if (!detail) return
    setPolicy(
      detail.access === 'active' || detail.access === 'read-only' || detail.access === 'blocked'
        ? detail.access
        : 'read-only',
    )
    setQuota(String(detail.capacity_bytes))
    setSelectedSessions([])
    setDeleteConfirmation('')
  }, [detail])
  function inspect(id: string) {
    setSelected(id)
    window.location.hash = routeHash('accounts', 'accountId', id)
  }
  function resetQuery() {
    page.reset()
    setSelected(null)
    window.location.hash = routeHash('accounts')
  }
  const target = detail && { kind: 'account' as const, id: detail.id }
  const quotaParsed = parseUnitBytesDetailed(quota, 'Bytes')
  return (
    <section>
      <h1 tabIndex={-1}>Accounts</h1>
      <p>Find an exact identity, inspect access and storage, then review a guarded action.</p>
      <form
        className="admin-search"
        onSubmit={(event) => {
          event.preventDefault()
          resetQuery()
          setFilter(search.trim())
        }}
      >
        <label>
          Find by{' '}
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as typeof kind)
              setSearch('')
              setFilter('')
              resetQuery()
            }}
          >
            <option value="email">Exact email</option>
            <option value="username">Exact username</option>
            <option value="accountId">Account ID</option>
          </select>
        </label>
        <label>
          Value{' '}
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={254}
          />
        </label>
        <label>
          Access{' '}
          <select
            value={access}
            onChange={(event) => {
              setAccess(event.target.value)
              resetQuery()
            }}
          >
            <option value="">All</option>
            {['pending', 'active', 'read-only', 'blocked', 'deleting'].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <button type="submit">Search</button>
        <button
          type="button"
          onClick={() => {
            setSearch('')
            setFilter('')
            setAccess('')
            resetQuery()
            void refresh()
          }}
        >
          Reset filters
        </button>
        <button type="button" onClick={() => void refresh()}>
          Refresh list
        </button>
      </form>
      <DataState loading={loading} error={error} empty={!!value && !value.items.length} />
      {value && !loading && (
        <>
          <ObservationNote value={value} />
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Access</th>
                  <th>Quota</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {value.items.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Account">
                      <button type="button" onClick={() => inspect(row.id)}>
                        Inspect account <span className="admin-id">{row.id}</span>
                      </button>
                      <small>
                        {row.email} · {row.username}
                      </small>
                    </td>
                    <td data-label="Access">
                      <StatusBadge value={row.access} />
                    </td>
                    <td data-label="Quota">{size(row.capacity_bytes)}</td>
                    <td data-label="Created">{time(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <PageControls
            page={value}
            index={page.index}
            previous={page.previous}
            next={page.next}
            reset={page.reset}
            noun="accounts"
          />
        </>
      )}
      {detailLoading && selected && <p role="status">Loading account detail...</p>}
      {detailError && (
        <p className="admin-error" role="alert">
          {detailError}
        </p>
      )}
      {detail && target && (
        <section className="admin-detail" aria-label="Account detail">
          <h2>
            Account <span className="admin-id">{detail.id}</span>
          </h2>
          <p>Full email (audited detail): {detail.email}</p>
          <p>
            Username {detail.username}
            {detail.username_withheld ? ' (public attribution withheld)' : ''} · Access{' '}
            <StatusBadge value={detail.access} /> · Verified {time(detail.verified_at)} · Revision {detail.revision}
          </p>
          <CapacityMeter
            used={accountedBytes(detail.storage)}
            limit={detail.capacity_bytes}
            label="Account quota"
            helpText="This per-account limit is separate from project capacity. Lowering it preserves stored data but blocks new increases when usage exceeds the limit."
          />
          <p>
            Used payload {size(detail.storage?.payload_bytes)} · <AdminHelp label="Reserved metadata" text="Space set aside for metadata and control overhead, including upload reservations and recovery work. It already counts toward capacity." />{' '}
            {size(detail.storage?.reserved_metadata)} · Metadata{' '}
            {size(detail.storage?.metadata_bytes)}
          </p>
          <p>
            Ciphertext objects {detail.counts?.objects ?? 'unknown'} · Revisions{' '}
            {detail.counts?.revisions ?? 'unknown'} · Public shares{' '}
            {detail.counts?.shares ?? 'unknown'}
          </p>
          <ObservationNote value={detail} />
          <label>
            Reason{' '}
            <select
              value={reason}
              onChange={(event) => setReason(event.target.value as typeof reason)}
            >
              <option value="support">Support</option>
              <option value="security">Security</option>
              <option value="abuse">Abuse</option>
              <option value="user-request">User request</option>
            </select>
          </label>
          <div className="admin-control">
            <label>
              Cloud access{' '}
              <select
                value={policy}
                onChange={(event) => setPolicy(event.target.value as typeof policy)}
              >
                <option value="active">Active</option>
                <option value="read-only">Read only</option>
                <option value="blocked">Blocked</option>
              </select>
            </label>
            <button
              type="button"
              disabled={
                detail.access === policy ||
                detail.access === 'pending' ||
                detail.access === 'deleting'
              }
              onClick={(event) =>
                openAction(event.currentTarget, target, detail.revision, { type: 'accounts.restrict', policy }, reason)
              }
            >
              Preview access change
            </button>
            <p>
              Read only keeps stored data readable while stopping new uploads and publications.
              Block revokes server sessions. Cached local copies and downloaded keys remain on
              devices.
            </p>
          </div>
          <div className="admin-control">
            <label>
              Account quota in bytes{' '}
              <input
                inputMode="decimal"
                value={quota}
                onChange={(event) => setQuota(event.target.value)}
              />
            </label>
            {quotaParsed.roundedFrom && quotaParsed.bytes !== null && <p>Rounded up to {quotaParsed.bytes.toLocaleString()} {quotaParsed.bytes === 1 ? 'byte' : 'bytes'}.</p>}
            <button
              type="button"
              disabled={
                quotaParsed.bytes === null ||
                detail.capacity_bytes === quotaParsed.bytes ||
                detail.access === 'pending'
              }
              onClick={(event) => {
                const quotaBytes = quotaParsed.bytes
                if (quotaBytes !== null)
                  openAction(
                    event.currentTarget,
                    target,
                    detail.revision,
                    { type: 'accounts.quota', quotaBytes },
                    reason,
                  )
              }}
            >
              Preview quota
            </button>
            <p>
              Reducing below used and reserved bytes preserves stored data and blocks capacity
              increases.
            </p>
          </div>
          <div className="admin-control">
            <h3>Customer sessions</h3>
            {detail.sessions.length ? (
              <ul>
                {detail.sessions.map((row) => (
                  <li key={row.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedSessions.includes(row.id)}
                        onChange={(event) =>
                          setSelectedSessions((ids) =>
                            event.target.checked
                              ? [...ids, row.id]
                              : ids.filter((id) => id !== row.id),
                          )
                        }
                      />{' '}
                      <span className="admin-id">{row.id}</span>
                    </label>{' '}
                    · Device <span className="admin-id">{row.device_id}</span> · Authenticated{' '}
                    {time(row.authenticated_at)}
                    {row.revoked_at ? ' · Revoked' : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No sessions observed.</p>
            )}
            {detail.sessionsTruncated && (
              <p>
                Session list truncated. All-session revocation includes sessions beyond this view.
              </p>
            )}
            <button
              type="button"
              disabled={!selectedSessions.length}
              onClick={(event) =>
                openAction(
                  event.currentTarget,
                  target,
                  detail.revision,
                  {
                    type: 'accounts.sessions.revoke',
                    all: false,
                    sessionIds: selectedSessions,
                    revokePendingApprovals: false,
                  },
                  'security',
                )
              }
            >
              Preview selected revocation
            </button>
            <button
              type="button"
              onClick={(event) =>
                openAction(
                  event.currentTarget,
                  target,
                  detail.revision,
                  {
                    type: 'accounts.sessions.revoke',
                    all: true,
                    revokePendingApprovals: true,
                  },
                  'security',
                )
              }
            >
              Preview all-session revocation
            </button>
            <p>
              Revocation stops server access and pending approvals only when selected. It cannot
              remove downloaded data or keys from a device.
            </p>
          </div>
          <div className="admin-actions">
            <button
              type="button"
              disabled={detail.access !== 'pending'}
              onClick={(event) =>
                openAction(
                  event.currentTarget,
                  target,
                  detail.revision,
                  { type: 'accounts.verification.resend' },
                  'support',
                )
              }
            >
              Preview verification resend
            </button>
            <button
              type="button"
              disabled={!!detail.username_withheld || detail.access === 'pending'}
              onClick={(event) =>
                openAction(event.currentTarget, target, detail.revision, { type: 'accounts.username.withhold' }, 'abuse')
              }
            >
              Preview attribution removal
            </button>
            <button type="button" onClick={() => void refreshDetail()}>
              Refresh detail
            </button>
          </div>
          {role === 'owner' && detail.access !== 'pending' && detail.access !== 'deleting' && (
            <div className="admin-control admin-danger">
              <h3>Permanent deletion</h3>
              <p>
                Deletion starts an irreversible journal. Existing local copies cannot be erased.
              </p>
              <label>
                Type account ID to continue{' '}
                <input
                  autoComplete="off"
                  spellCheck={false}
                  value={deleteConfirmation}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={deleteConfirmation !== detail.id}
                onClick={(event) =>
                  openAction(
                    event.currentTarget,
                    target,
                    detail.revision,
                    { type: 'accounts.delete', confirmation: detail.id },
                    'user-request',
                  )
                }
              >
                Preview permanent deletion
              </button>
            </div>
          )}
        </section>
      )}
    </section>
  )
}
