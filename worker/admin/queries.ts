import { z } from 'zod'
import { AdminListQuerySchema, adminLimits } from '../../src/account/admin-protocol'
import { OpaqueIdSchema } from '../../src/account/protocol'
import { keyedHash, normalizedEmail, randomId } from '../auth/identity'
import type { ServiceContext } from '../context'
import { ApiFailure, jsonResponse } from '../http'
import { validatePublicSnapshot } from '../../src/interchange/public-share-schema'
import { adminAuditStatement, commitAdminBatch } from './audit'
import { operatorGuard, type OperatorPrincipal } from './session'

export async function assertLiveOperator(actor: OperatorPrincipal, context: ServiceContext) {
  const guard = operatorGuard(actor, context)
  if (
    !(await context.env
      .DB!.prepare(guard.sql)
      .bind(...guard.bindings)
      .first())
  )
    throw new ApiFailure('FORBIDDEN')
}
type SettingsRow = {
  revision: number
  registration_paused: number
  uploads_paused: number
  sharing_paused: number
  email_paused: number
  max_account_bytes: number | null
  project_capacity_bytes: number | null
}
export async function adminSettings(context: ServiceContext) {
  const row = await context.env
    .DB!.prepare(
      "SELECT revision,registration_paused,uploads_paused,sharing_paused,email_paused,max_account_bytes,project_capacity_bytes FROM service_settings WHERE id='service'",
    )
    .first<SettingsRow>()
  if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return projectedSettings(row, Number(context.env.STORAGE_CAP_BYTES))
}
function projectedSettings(row: SettingsRow, deploymentCapacity: number) {
  return {
    revision: row.revision,
    registrationPaused: !!row.registration_paused,
    uploadsPaused: !!row.uploads_paused,
    sharingPaused: !!row.sharing_paused,
    emailPaused: !!row.email_paused,
    maxAccountBytes: Math.min(row.max_account_bytes ?? deploymentCapacity, deploymentCapacity),
    projectCapacityBytes: Math.min(row.project_capacity_bytes ?? deploymentCapacity, deploymentCapacity),
    deploymentCapacity,
  }
}
const observed = (context: ServiceContext, at = context.now()) => ({
  observedAt: at,
  source: 'application-database',
  freshness: 'request-read',
  offlineOutboxes: 'unobserved',
  providerHeadroom: 'unknown',
})
const maskedEmail = (email: string) => `${email.slice(0, 1)}***@***`
const tables = {
  accounts: {
    table: 'admin_account_metadata',
    columns:
      'id,delivery_email,username,username_withheld,access,revision,capacity_bytes,verified_at,created_at',
  },
  shares: {
    table: 'shares',
    columns: 'id,account_id,revision,state,created_at,updated_at',
  },
  jobs: {
    table: 'admin_job_metadata',
    columns: 'id,type,phase,account_id,revision,attempts,next_at,outcome,code,request_id,created_at',
  },
  operators: {
    table: 'operators',
    columns: 'id,email,role,state,revision,created_at',
  },
  audit: {
    table: 'admin_audit',
    columns:
      'id,actor_id,action,target_kind,target_id,action_id,reason,case_id,outcome,policy_before,policy_after,request_id,created_at',
  },
} as const
const cursorSchema = z.tuple([z.number().int().nonnegative(), z.string().min(1).max(128)])
async function cursor(
  value: string | undefined,
  scope: string,
  context: ServiceContext,
): Promise<[number, string]> {
  if (!value) return [0, '']
  const [body, signature, ...extra] = value.split('.')
  if (
    !body ||
    !signature ||
    extra.length ||
    (await keyedHash(context.env.CURSOR_SECRET, `admin-cursor:${scope}`, body)) !== signature
  )
    throw new ApiFailure('STALE_CURSOR')
  try {
    return cursorSchema.parse(JSON.parse(atob(body)))
  } catch {
    throw new ApiFailure('STALE_CURSOR')
  }
}
async function encodeCursor(row: Record<string, unknown>, scope: string, context: ServiceContext) {
  const body = btoa(JSON.stringify([row.created_at, row.id]))
  return `${body}.${await keyedHash(context.env.CURSOR_SECRET, `admin-cursor:${scope}`, body)}`
}
export async function adminQuery(
  request: Request,
  actor: OperatorPrincipal,
  context: ServiceContext,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname.slice('/api/admin/v1/'.length),
    db = context.env.DB!
  if (request.method !== 'GET') return null
  await assertLiveOperator(actor, context)
  if (path === 'settings' && !url.search)
    return jsonResponse({
      ...(await adminSettings(context)),
      ...observed(context),
    })
  if (path === 'overview') {
    if (url.search) throw new ApiFailure('INVALID_REQUEST')
    const at = context.now()
    // One singleton statement keeps effective limits and persisted accounting coherent
    const pair = await db
      .prepare(
        "SELECT s.revision,s.registration_paused,s.uploads_paused,s.sharing_paused,s.email_paused,s.max_account_bytes,s.project_capacity_bytes,q.payload_bytes,q.reserved_metadata,q.metadata_bytes,q.metadata_rows FROM service_settings s LEFT JOIN quota_counters q ON q.scope='global' WHERE s.id='service'",
      )
      .first<SettingsRow & {
        payload_bytes: number | null
        reserved_metadata: number | null
        metadata_bytes: number | null
        metadata_rows: number | null
      }>()
    if (!pair) throw new ApiFailure('SERVICE_UNAVAILABLE')
    const settings = projectedSettings(pair, Number(context.env.STORAGE_CAP_BYTES))
    const counters = pair.payload_bytes === null ? null : {
      payload_bytes: pair.payload_bytes,
      reserved_metadata: pair.reserved_metadata!,
      metadata_bytes: pair.metadata_bytes!,
      metadata_rows: pair.metadata_rows!,
    }
    const usedBytes = counters && counters.payload_bytes + counters.reserved_metadata + counters.metadata_bytes
    const capacity = usedBytes === null ? null : {
      usedBytes,
      availableBytes: Math.max(0, settings.projectCapacityBytes - usedBytes),
      overCapacity: usedBytes > settings.projectCapacityBytes,
    }
    // Persisted accounting is an application estimate, not provider billing or offline device progress
    const oldest = await db
      .prepare(
        "SELECT id,type,next_at,created_at FROM service_jobs WHERE outcome='pending' ORDER BY created_at,id LIMIT 1",
      )
      .first()
    const accounts = await db
      .prepare("SELECT rows FROM recovery_source_stats WHERE name='accounts'")
      .first<number>('rows')
    const windowStart = at - 24 * 60 * 60 * 1000
    const email = await db
      .prepare(
        'SELECT state,count(*) AS count FROM email_jobs WHERE created_at>=? AND created_at<=? GROUP BY state',
      )
      .bind(windowStart, at)
      .all()
    const recentFailures = await db
      .prepare(
        'SELECT id,job_id,stage,code,created_at FROM service_audit WHERE created_at>=? AND created_at<=? AND code IS NOT NULL ORDER BY created_at DESC LIMIT ?',
      )
      .bind(windowStart, at, adminLimits.defaultPage)
      .all()
    return jsonResponse({
      accounts,
      counters,
      settings,
      capacity,
      email: { windowStart, windowEnd: at, states: email.results },
      recentFailures: recentFailures.results,
      oldestUnfinishedJob: oldest,
      estimate: true,
      ...observed(context, at),
    })
  }
  const detail = /^(accounts|shares|jobs)\/([^/]+)$/.exec(path)
  if (detail) {
    if (url.search || !OpaqueIdSchema.safeParse(detail[2]).success) throw new ApiFailure('INVALID_REQUEST')
    const [kind, id] = [detail[1], detail[2]]
    if (kind === 'accounts') {
      // Commit sensitive-read evidence before even selecting the full email projection
      await commitAdminBatch(
        operatorGuard(actor, context),
        [
          adminAuditStatement(
            actor,
            {
              target: { kind: 'account', id },
              actionId: randomId(),
              reason: 'support',
            },
            'accounts.detail',
            'read',
            context,
          ),
        ],
        context,
        'FORBIDDEN',
      )
      const row = await db
        .prepare(
          'SELECT id,delivery_email AS email,username,username_withheld,access,revision,capacity_bytes,verified_at,created_at FROM admin_account_metadata WHERE id=?',
        )
        .bind(id)
        .first()
      if (!row) throw new ApiFailure('NOT_FOUND')
      const storage = await db
        .prepare(
          'SELECT payload_bytes,reserved_metadata,metadata_bytes,metadata_rows FROM quota_counters WHERE scope=?',
        )
        .bind(id)
        .first()
      const counts = await db
        .prepare(
          'SELECT (SELECT count(*) FROM sync_documents WHERE account_id=?) AS objects,(SELECT count(*) FROM sync_revisions WHERE account_id=?) AS revisions,(SELECT count(*) FROM shares WHERE account_id=?) AS shares',
        )
        .bind(id, id, id)
        .first()
      await assertLiveOperator(actor, context)
      const sessions = await db
        .prepare(
          'SELECT id,device_id,authenticated_at,idle_expires_at,absolute_expires_at,revoked_at FROM customer_sessions WHERE account_id=? ORDER BY id LIMIT ?',
        )
        .bind(id, adminLimits.maxPage + 1)
        .all()
      return jsonResponse({
        ...row,
        storage,
        counts,
        sessions: sessions.results.slice(0, adminLimits.maxPage),
        sessionsTruncated: sessions.results.length > adminLimits.maxPage,
        ...observed(context),
      })
    }
    if (kind === 'shares') {
      const row = await db
        .prepare(
          'SELECT s.id,s.account_id,s.revision,s.state,s.created_at,s.updated_at,p.snapshot FROM shares s JOIN share_snapshots p ON p.share_id=s.id AND p.revision=s.snapshot_revision WHERE s.id=?',
        )
        .bind(id)
        .first<{ snapshot: string }>()
      if (!row) throw new ApiFailure('NOT_FOUND')
      return jsonResponse({
        ...row,
        snapshot: validatePublicSnapshot(JSON.parse(row.snapshot)),
        ...observed(context),
      })
    }
    const row = await db
      .prepare(`SELECT ${tables.jobs.columns} FROM admin_job_metadata WHERE id=?`)
      .bind(id)
      .first()
    if (!row) {
      const revocation = await db
        .prepare(
          "SELECT r.id,'admin-revocation' AS type,CASE WHEN r.acknowledged=1 THEN 'complete' ELSE 'pending' END AS outcome,r.code FROM admin_revocations r JOIN admin_actions a ON a.id=r.action_id AND json_extract(a.receipt,'$.jobId')=r.id WHERE r.id=?",
        )
        .bind(id)
        .first()
      if (revocation) return jsonResponse({ ...revocation, ...observed(context) })
      // Customer mutation IDs are account-scoped; only the exact accepted admin Stop receipt is a job
      const stop = await db
        .prepare(
          "SELECT m.mutation_id AS id,m.share_id,'share-stop' AS type,CASE WHEN m.receipt IS NULL THEN 'pending' ELSE 'complete' END AS outcome FROM share_mutations m JOIN admin_actions a ON a.target_kind='share' AND a.target_id=m.share_id AND a.action='shares.revoke' AND json_extract(a.receipt,'$.jobId')=m.mutation_id WHERE m.mutation_id=? AND m.kind='stop'",
        )
        .bind(id)
        .first()
      if (!stop) throw new ApiFailure('NOT_FOUND')
      return jsonResponse({ ...stop, ...observed(context) })
    }
    return jsonResponse({ ...row, ...observed(context) })
  }
  if (!(path in tables)) return null
  const parsed = AdminListQuerySchema.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success || [...url.searchParams.keys()].length !== new Set(url.searchParams.keys()).size)
    throw new ApiFailure('INVALID_REQUEST')
  const query = parsed.data,
    key = path as keyof typeof tables,
    table = tables[key]
  if (
    (query.access !== undefined && key !== 'accounts') ||
    (query.state !== undefined && key !== 'shares') ||
    (query.type !== undefined && key !== 'jobs') ||
    (query.action !== undefined && key !== 'audit') ||
    (query.outcome !== undefined &&
      (key === 'jobs'
        ? !['pending', 'queued', 'running', 'waiting', 'failed', 'complete'].includes(query.outcome)
        : key === 'audit'
          ? !['complete', 'queued', 'denied', 'read'].includes(query.outcome)
          : true))
  ) throw new ApiFailure('INVALID_REQUEST')
  const filter = query.email
    ? ['normalized_email', normalizedEmail(query.email)]
    : query.username
      ? ['username', query.username]
      : query.accountId
        ? [key === 'accounts' ? 'id' : 'account_id', query.accountId]
        : query.shareId
          ? ['id', query.shareId]
          : query.jobId
            ? ['id', query.jobId]
            : null
  if (
    filter &&
    !(
      (key === 'accounts' && !query.shareId && !query.jobId) ||
      (key === 'shares' && (query.accountId || query.shareId)) ||
      (key === 'jobs' && (query.accountId || query.jobId))
    )
  )
    throw new ApiFailure('INVALID_REQUEST')
  // Preserve the original ascending signature for issued cursors and bind new facets for changed views
  const legacyScope = query.order === 'asc' &&
    query.access === undefined && query.state === undefined && query.type === undefined &&
    query.outcome === undefined && query.action === undefined
  const scope = await keyedHash(
    context.env.CURSOR_SECRET,
    'admin-search',
    JSON.stringify(legacyScope
      ? [actor.operatorId, path, filter]
      : [actor.operatorId, path, filter, query.order, query.access ?? null, query.state ?? null,
          query.type ?? null, query.outcome ?? null, query.action ?? null]),
  )
  const [time, id] = await cursor(query.cursor, scope, context)
  // Route and facet names come only from these fixed clauses; every caller value is bound
  const clauses: string[] = []
  const bindings: (string | number)[] = []
  if (query.cursor) {
    clauses.push(`(created_at,id)${query.order === 'asc' ? '>' : '<'}(?,?)`)
    bindings.push(time, id)
  }
  if (filter) {
    clauses.push(`${filter[0]}=?`)
    bindings.push(filter[1])
  }
  for (const [column, value] of [
    ['access', query.access], ['state', query.state], ['type', query.type],
    ['outcome', query.outcome], ['action', query.action],
  ] as const) if (value !== undefined) {
    clauses.push(`${column}=?`)
    bindings.push(value)
  }
  const direction = query.order === 'asc' ? 'ASC' : 'DESC'
  let sql = `SELECT ${table.columns} FROM ${table.table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at ${direction},id ${direction} LIMIT ?`
  let params = [...bindings, query.limit + 1]
  if (key === 'accounts' || key === 'jobs') {
    type Branch = { select: string; from: string; predicates: string[]; values: (string | number)[] }
    const branches: Branch[] = []
    const branch = (select: string, from: string, idColumn: string, filterColumns: Record<string, string>) => {
      const predicates: string[] = []
      const values: (string | number)[] = []
      if (query.cursor) {
        predicates.push(`(created_at,${idColumn})${query.order === 'asc' ? '>' : '<'}(?,?)`)
        values.push(time, id)
      }
      if (filter) {
        predicates.push(`${filterColumns[filter[0]]}=?`)
        values.push(filter[1])
      }
      const result = { select, from, predicates, values }
      branches.push(result)
      return result
    }
    if (key === 'accounts') {
      if (query.access !== 'pending') {
        const source = branch(tables.accounts.columns, 'accounts', 'id', {
          id: 'id', normalized_email: 'normalized_email', username: 'username',
        })
        if (query.access) {
          source.predicates.push('access=?')
          source.values.push(query.access)
        }
      }
      if (query.access === undefined || query.access === 'pending') {
        const source = branch(
          "account_id AS id,delivery_email,username,0 AS username_withheld,'pending' AS access,verification_revision AS revision,0 AS capacity_bytes,NULL AS verified_at,created_at",
          'pending_registrations p', 'p.account_id', {
            id: 'p.account_id', normalized_email: 'p.normalized_email', username: 'p.username',
          },
        )
        source.predicates.push('p.registration_record IS NOT NULL',
          'NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id=p.account_id)')
      }
    } else {
      const serviceOutcome = query.outcome === undefined || ['pending', 'complete'].includes(query.outcome)
      const emailOutcome = query.outcome === undefined || query.outcome !== 'pending'
      if (query.type !== 'email' && serviceOutcome) {
        const source = branch(
          'id,type,phase,account_id,admin_revision AS revision,attempts,next_at,outcome,code,request_id,created_at',
          'service_jobs', 'id', { id: 'id', account_id: 'account_id' },
        )
        if (query.type) {
          source.predicates.push('type=?')
          source.values.push(query.type)
        }
        if (query.outcome) {
          source.predicates.push('outcome=?')
          source.values.push(query.outcome)
        }
      }
      // Email jobs have no account identity; encrypted transport payloads are not search authority
      if ((query.type === undefined || query.type === 'email') && !query.accountId && emailOutcome) {
        const source = branch(
          "id,'email' AS type,delivery AS phase,NULL AS account_id,admin_revision AS revision,attempts,next_attempt_at AS next_at,state AS outcome,code,request_id,created_at",
          'email_jobs', 'id', { id: 'id' },
        )
        if (query.outcome) {
          source.predicates.push('state=?')
          source.values.push(query.outcome)
        }
      }
    }
    // Each source contributes at most limit+1 rows before the final ordered merge
    const sourceSql = (source: Branch) => `SELECT ${source.select} FROM ${source.from}${source.predicates.length ? ` WHERE ${source.predicates.join(' AND ')}` : ''} ORDER BY created_at ${direction},id ${direction} LIMIT ?`
    if (branches.length === 1) {
      sql = sourceSql(branches[0])
      params = [...branches[0].values, query.limit + 1]
    } else if (branches.length === 2) {
      sql = `WITH source0 AS (${sourceSql(branches[0])}),source1 AS (${sourceSql(branches[1])}) SELECT ${table.columns} FROM source0 UNION ALL SELECT ${table.columns} FROM source1 ORDER BY created_at ${direction},id ${direction} LIMIT ?`
      params = [...branches[0].values, query.limit + 1, ...branches[1].values, query.limit + 1, query.limit + 1]
    } else {
      // A valid facet can exclude both physical job branches
      await assertLiveOperator(actor, context)
      return jsonResponse({ items: [], next: null, limit: query.limit, ...observed(context) })
    }
  }
  const rows = await db.prepare(sql).bind(...params).all<Record<string, unknown>>()
  const page = rows.results.slice(0, query.limit)
  const next = rows.results.length > query.limit ? await encodeCursor(page.at(-1)!, scope, context) : null
  const items = page.map((row) => {
    const { delivery_email, email, ...rest } = row
    return {
      ...rest,
      ...(typeof delivery_email === 'string'
        ? { email: maskedEmail(delivery_email) }
        : typeof email === 'string'
          ? { email: maskedEmail(email) }
          : {}),
    }
  })
  await assertLiveOperator(actor, context)
  return jsonResponse({
    items,
    next,
    limit: query.limit,
    ...observed(context),
  })
}
