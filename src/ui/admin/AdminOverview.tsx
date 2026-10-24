import type { AdminClient } from './admin-client'
import { accountedBytes, storageDistribution } from './admin-math'
import { CapacityMeter } from './admin-components'
import { AdminHelp, StatusBadge } from './admin-help'
import { routeHash } from './admin-route'
import { ObservationNote, size, time, type Observation } from './admin-view'
import { DataState, useAdminData } from './useAdminData'

interface Counters {
  payload_bytes: number
  reserved_metadata: number
  metadata_bytes: number
  metadata_rows: number
}
interface Overview extends Observation {
  accounts: number | null
  counters: Counters | null
  settings: { projectCapacityBytes: number }
  capacity: {
    usedBytes: number
    availableBytes: number
    overCapacity: boolean
  } | null
  email: {
    windowStart: number
    windowEnd: number
    states: { state: string; count: number }[]
  }
  recentFailures: {
    id: string
    job_id: string
    stage: string
    code: string
    created_at: number
  }[]
  oldestUnfinishedJob: {
    id: string
    type: string
    next_at: number
    created_at: number
  } | null
  estimate: true
}

export default function AdminOverview({ client }: { client: AdminClient }) {
  const { value, loading, error, refresh } = useAdminData<Overview>(client, 'overview')
  const used = accountedBytes(value?.counters)
  const distribution = storageDistribution(value?.counters)
  const emailMax = Math.max(0, ...(value?.email.states.map((row) => row.count) ?? []))
  return (
    <section>
      <h1 tabIndex={-1}>Overview</h1>
      <p>
        Service observations from the application database. Each section reflects its own request
        read.
      </p>
      <button type="button" onClick={() => void refresh()}>
        Refresh observations
      </button>
      <DataState loading={loading} error={error} />
      {value && (
        <>
          <ObservationNote value={value} />
          <div className="admin-cards">
            <article>
              <h2>Activated accounts</h2>
              <strong>{value.accounts?.toLocaleString() ?? 'Unavailable'}</strong>
              <p>Pending registrations are excluded.</p>
            </article>
            <article>
              <h2><AdminHelp label="Accounted storage" text="The sum of encrypted payload, reserved metadata and stored metadata, counted once by the application. It is not physical provider storage or billing usage." /></h2>
              <strong>{used == null ? 'Unavailable' : size(used)}</strong>
              <p>Application estimate across encrypted payload and metadata.</p>
            </article>
            <article>
              <h2>Oldest unfinished job</h2>
              {value.oldestUnfinishedJob ? (
                <>
                  <strong>{value.oldestUnfinishedJob.type}</strong>
                  <p>Created {time(value.oldestUnfinishedJob.created_at)}</p>
                  <a
                    className="admin-id"
                    href={routeHash('jobs', 'jobId', value.oldestUnfinishedJob.id)}
                  >
                    Inspect job {value.oldestUnfinishedJob.id}
                  </a>
                </>
              ) : (
                <strong>None observed</strong>
              )}
            </article>
          </div>
          <div className="admin-dashboard-grid">
            <section className="admin-panel">
              <h2>Storage composition</h2>
              <CapacityMeter
                used={used}
                limit={value.settings.projectCapacityBytes}
                label="Application capacity"
                helpText="The effective project ceiling set by the owner and bounded by deployment capacity. Account quotas are separate; this is not the provider storage allowance."
              />
              {distribution && (
                <>
                  <p className="admin-distribution-label">Share of accounted storage</p>
                  <div
                    className="admin-distribution"
                    role="img"
                    aria-label={`Share of accounted storage: encrypted payload ${distribution[0].toFixed(1)}%, reserved metadata ${distribution[1].toFixed(1)}%, stored metadata ${distribution[2].toFixed(1)}%`}
                  >
                    <span
                      className="admin-distribution__payload"
                      style={{ width: `${distribution[0]}%` }}
                    />
                    <span
                      className="admin-distribution__reserved"
                      style={{ width: `${distribution[1]}%` }}
                    />
                    <span
                      className="admin-distribution__stored"
                      style={{ width: `${distribution[2]}%` }}
                    />
                  </div>
                </>
              )}
              <div className="admin-storage-parts">
                <div>
                  <span>
                    <i className="admin-distribution-key admin-distribution__payload" aria-hidden="true" />
                    <AdminHelp label="Encrypted payload" text="Encrypted account content and its chunk-control reservation. Cleanup and accounting depend on the content lifecycle." />
                  </span>
                  <strong>{size(value.counters?.payload_bytes)}</strong>
                </div>
                <div>
                  <span>
                    <i className="admin-distribution-key admin-distribution__reserved" aria-hidden="true" />
                    <AdminHelp label="Reserved metadata" text="Space set aside for metadata and control overhead, including upload reservations, recovery work and fixed service allowances. It already counts toward capacity." />
                  </span>
                  <strong>{size(value.counters?.reserved_metadata)}</strong>
                </div>
                <div>
                  <span>
                    <i className="admin-distribution-key admin-distribution__stored" aria-hidden="true" />
                    <AdminHelp label="Stored metadata" text="Encoded account and service records counted by application accounting. This is not a measure of physical database page size." />
                  </span>
                  <strong>{size(value.counters?.metadata_bytes)}</strong>
                </div>
              </div>
              <p>
                Metadata rows: {value.counters?.metadata_rows ?? 'Unavailable'}. Accounted bytes add
                these three components once. Provider allowance and offline device outboxes are
                unobserved.
              </p>
            </section>
            <section className="admin-panel">
              <h2>Email job states</h2>
              <p>
                Observed {time(value.email.windowStart)} to {time(value.email.windowEnd)}. Job
                completion does not confirm recipient delivery.
              </p>
              {emailMax > 0 ? (
                <ul className="admin-bars">
                  {value.email.states.map((row) => (
                    <li key={row.state}>
                      <StatusBadge value={row.state} helpText={row.state === 'accepted' ? 'The provider accepted transport. Recipient delivery is not confirmed.' : row.state === 'uncertain' ? 'Provider acceptance cannot be established. Automatic resend is not safe without further evidence.' : 'An application job state, not proof of recipient delivery.'} />
                      <div
                        className="admin-meter"
                        role="img"
                        aria-label={`${row.state}: ${row.count} jobs`}
                      >
                        <span style={{ width: `${(row.count / emailMax) * 100}%` }} />
                      </div>
                      <strong>{row.count.toLocaleString()}</strong>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No email jobs observed in this window.</p>
              )}
              <a href={routeHash('jobs')}>Inspect jobs</a>
            </section>
          </div>
          <section className="admin-panel admin-failures">
            <h2>Recent service failures</h2>
            <p>This is a capped sample of service job failures, not a complete history.</p>
            {value.recentFailures.length ? (
              <ul className="admin-list">
                {value.recentFailures.map((row) => (
                  <li key={row.id}>
                    <strong>{row.code}</strong>
                    <span>
                      {row.stage} · {time(row.created_at)}
                    </span>
                    <a className="admin-id" href={routeHash('jobs', 'jobId', row.job_id)}>
                      Inspect job {row.job_id}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p>None observed in this sample.</p>
            )}
          </section>
        </>
      )}
    </section>
  )
}
