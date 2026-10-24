import { useEffect, useState } from 'react'
import type { AdminClient } from './admin-client'
import {
  ObservationNote,
  time,
  type ActionOpener,
  type JobRow,
  type Observation,
  type Page,
} from './admin-view'
import { DataState, useAdminData } from './useAdminData'
import { PageControls, useActionRefresh, useAdminDetail, usePage } from './admin-components'
import { StatusBadge } from './admin-help'
import { routeHash } from './admin-route'

type JobDetail = JobRow & Observation
const outcomeLabels: Record<string, string> = Object.freeze({
  queued: 'Queued',
  pending: 'Queued',
  running: 'Running',
  waiting: 'Waiting to retry',
  failed: 'Failed',
  complete: 'Complete',
})
function outcomeText(job: Pick<JobRow, 'type' | 'phase' | 'outcome'>): string {
  if (job.type === 'email' && job.phase === 'uncertain') return 'Delivery uncertain'
  if (job.type === 'email' && job.phase === 'accepted')
    return 'Transport accepted, delivery unconfirmed'
  return outcomeLabels[job.outcome] ?? job.outcome
}
export default function AdminJobs({
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
  const [kind, setKind] = useState<'jobId' | 'accountId'>('jobId')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('')
  const [type, setType] = useState('')
  const [outcome, setOutcome] = useState('')
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
  } = useAdminDetail<JobDetail>(client, 'jobs', selected, refreshKey)
  const path = `jobs?limit=50&order=desc${filter ? `&${kind}=${encodeURIComponent(filter)}` : ''}${type ? `&type=${type}` : ''}${outcome ? `&outcome=${outcome}` : ''}${page.cursor ? `&cursor=${encodeURIComponent(page.cursor)}` : ''}`
  const { value, loading, error, refresh } = useAdminData<Page<JobRow>>(client, path)
  useActionRefresh(refreshKey, refresh)
  function inspect(id: string) {
    setSelected(id)
    window.location.hash = routeHash('jobs', 'jobId', id)
  }
  function resetQuery() {
    page.reset()
    setSelected(null)
    window.location.hash = routeHash('jobs')
  }
  return (
    <section>
      <h1 tabIndex={-1}>Jobs and email</h1>
      <p>
        Queued work may finish after this page closes. Email transport acceptance does not prove
        recipient delivery.
      </p>
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
            <option value="jobId">Job ID</option>
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
          Type{' '}
          <select
            value={type}
            onChange={(event) => {
              setType(event.target.value)
              resetQuery()
            }}
          >
            <option value="">All</option>
            {['email', 'deletion', 'cleanup'].map((item) => (
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
              resetQuery()
            }}
          >
            <option value="">All</option>
            {['pending', 'queued', 'running', 'waiting', 'failed', 'complete'].map((item) => (
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
            setType('')
            setOutcome('')
            resetQuery()
          }}
        >
          Reset filters
        </button>
        <button type="button" onClick={() => void refresh()}>
          Refresh list
        </button>
      </form>
      {kind === 'accountId' && filter && (
        <p className="admin-observation">
          Account filtering covers account-linked service jobs. Email job metadata has no account
          ID, so email jobs are absent from this result.
        </p>
      )}
      <DataState loading={loading} error={error} empty={!!value && !value.items.length} />
      {value && !loading && (
        <>
          <ObservationNote value={value} />
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Type and outcome</th>
                  <th>Attempts</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {value.items.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Job">
                      <button type="button" onClick={() => inspect(row.id)}>
                        Inspect job <span className="admin-id">{row.id}</span>
                      </button>
                      {row.code && <small>Diagnostic {row.code}</small>}
                    </td>
                    <td data-label="Type and outcome">
                      {row.type} · <StatusBadge value={outcomeText(row)} helpText={row.type === 'email' && ['accepted', 'uncertain'].includes(row.phase) ? row.phase === 'accepted' ? 'Transport was accepted by the provider; recipient delivery is not confirmed.' : 'Provider acceptance cannot be established. Do not assume an automatic resend is safe.' : undefined} />
                      <small>Phase {row.phase}</small>
                    </td>
                    <td data-label="Attempts">{row.attempts}</td>
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
            noun="jobs"
          />
        </>
      )}
      {detailLoading && selected && <p role="status">Loading job detail...</p>}
      {detailError && (
        <p className="admin-error" role="alert">
          {detailError}
        </p>
      )}
      {detail && (
        <section className="admin-detail" aria-label="Job detail">
          <h2>
            Job <span className="admin-id">{detail.id}</span>
          </h2>
          <p>
            {detail.type} · {outcomeText(detail)} · Phase {detail.phase} · Attempts{' '}
            {detail.attempts}
          </p>
          <p>
            Created {time(detail.created_at)} · Next attempt {time(detail.next_at)}
          </p>
          {detail.account_id && (
            <p>
              Account{' '}
              <a className="admin-id" href={routeHash('accounts', 'accountId', detail.account_id)}>
                {detail.account_id}
              </a>
            </p>
          )}
          <p>
            Request {detail.request_id}
            {detail.code && ` · Diagnostic ${detail.code}`}
          </p>
          <ObservationNote value={detail} />
          <div className="admin-actions">
            <button
              type="button"
              disabled={
                detail.outcome !== 'failed' ||
                (detail.type === 'email' && detail.phase !== 'unsent')
              }
              onClick={(event) =>
                openAction(
                  event.currentTarget,
                  { kind: 'job', id: detail.id },
                  detail.revision,
                  { type: 'jobs.retry' },
                  'operations',
                )
              }
            >
              Preview retry
            </button>
            <button
              type="button"
              disabled={
                detail.type !== 'email' ||
                detail.attempts !== 0 ||
                !['pending', 'queued'].includes(detail.outcome)
              }
              onClick={(event) =>
                openAction(
                  event.currentTarget,
                  { kind: 'job', id: detail.id },
                  detail.revision,
                  { type: 'jobs.cancel' },
                  'operations',
                )
              }
            >
              Preview cancellation
            </button>
            <button type="button" onClick={() => void refreshDetail()}>
              Refresh job
            </button>
          </div>
          <p>
            Retry and cancellation are limited by the service's durable attempt, lease, expiry and
            irreversible-work guards.
          </p>
        </section>
      )}
    </section>
  )
}
