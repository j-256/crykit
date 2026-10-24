import { useEffect, useState } from 'react'
import type { PublicSnapshot } from '../../interchange/public-share-schema'
import type { AdminClient } from './admin-client'
import {
  ObservationNote,
  time,
  type ActionOpener,
  type Observation,
  type Page,
  type ShareRow,
} from './admin-view'
import { DataState, useAdminData } from './useAdminData'
import { PageControls, useActionRefresh, useAdminDetail, usePage } from './admin-components'
import { StatusBadge } from './admin-help'
import { routeHash } from './admin-route'

interface ShareDetail extends ShareRow, Observation {
  snapshot: PublicSnapshot
}
export default function AdminSharing({
  client,
  openAction,
  routeTarget = null,
  refreshKey = 0,
}: {
  client: AdminClient
  openAction: ActionOpener
  routeTarget?: string | null
  refreshKey?: number
}) {
  const [kind, setKind] = useState<'shareId' | 'accountId'>('shareId')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [state, setState] = useState('')
  const page = usePage()
  const [selected, setSelected] = useState<string | null>(routeTarget)
  useEffect(() => {
    setSelected(routeTarget)
  }, [routeTarget])
  const {
    value: detail,
    error: errorDetail,
    loading: detailLoading,
    refresh: refreshDetail,
  } = useAdminDetail<ShareDetail>(client, 'shares', selected, refreshKey)
  const path = `shares?limit=50&order=desc${filter ? `&${kind}=${encodeURIComponent(filter)}` : ''}${state ? `&state=${state}` : ''}${page.cursor ? `&cursor=${encodeURIComponent(page.cursor)}` : ''}`
  const { value, loading, error, refresh } = useAdminData<Page<ShareRow>>(client, path)
  useActionRefresh(refreshKey, refresh)
  function inspect(id: string) {
    setSelected(id)
    window.location.hash = routeHash('sharing', 'shareId', id)
  }
  function resetQuery() {
    page.reset()
    setSelected(null)
    window.location.hash = routeHash('sharing')
  }
  return (
    <section>
      <h1 tabIndex={-1}>Sharing</h1>
      <p>Inspect intentional public snapshots and stop hosted links.</p>
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
            <option value="shareId">Share ID</option>
            <option value="accountId">Account ID</option>
          </select>
        </label>
        <label>
          Value{' '}
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={64}
          />
        </label>
        <label>
          State{' '}
          <select
            value={state}
            onChange={(event) => {
              setState(event.target.value)
              resetQuery()
            }}
          >
            <option value="">All</option>
            {['active', 'stopping', 'stopped'].map((item) => (
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
            setState('')
            resetQuery()
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
                  <th>Share</th>
                  <th>State</th>
                  <th>Account</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {value.items.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Share">
                      <button type="button" onClick={() => inspect(row.id)}>
                        Inspect share <span className="admin-id">{row.id}</span>
                      </button>
                    </td>
                    <td data-label="State">
                      <StatusBadge value={row.state} />
                    </td>
                    <td data-label="Account">
                      <a
                        className="admin-id"
                        href={routeHash('accounts', 'accountId', row.account_id)}
                      >
                        {row.account_id}
                      </a>
                    </td>
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
            noun="shares"
          />
        </>
      )}
      {detailLoading && selected && <p role="status">Loading share detail...</p>}
      {errorDetail && (
        <p className="admin-error" role="alert">
          {errorDetail}
        </p>
      )}
      {detail && (
        <section className="admin-detail" aria-label="Share detail">
          <h2>
            Hosted share <span className="admin-id">{detail.id}</span>
          </h2>
          <p>
            {detail.state} · Revision {detail.revision} · Account{' '}
            <a className="admin-id" href={routeHash('accounts', 'accountId', detail.account_id)}>
              {detail.account_id}
            </a>
          </p>
          <p>
            Created {time(detail.created_at)} · Updated {time(detail.updated_at)}
          </p>
          <ObservationNote value={detail} />
          <h3>Published snapshot</h3>
          <p>
            {detail.snapshot.kind === 'build' ? 'Build' : 'Team'}: {detail.snapshot.title}
          </p>
          <p>
            Published selections:{' '}
            {detail.snapshot.receipts.map((row) => row.name).join(', ') || 'None'}
          </p>
          {detail.snapshot.notes?.checkpoint && (
            <p>Public checkpoint: {detail.snapshot.notes.checkpoint}</p>
          )}
          <div className="admin-actions">
            <button
              type="button"
              disabled={detail.state !== 'active'}
              onClick={(event) =>
                openAction(
                  event.currentTarget,
                  { kind: 'share', id: detail.id },
                  detail.revision,
                  { type: 'shares.revoke' },
                  'abuse',
                )
              }
            >
              Preview link revocation
            </button>
            <button type="button" onClick={() => void refreshDetail()}>
              Refresh share
            </button>
          </div>
          <p>
            Revocation stops new hosted retrieval. Saved copies and legacy links outside this hosted
            identifier cannot be recalled.
          </p>
        </section>
      )}
    </section>
  )
}
