import { ApiFailure } from './http'
import { base64urlSchema, digestBytes, OpaqueFieldSchemas, type SafeEvent } from '../src/account/protocol'
import type { SendEmail } from '@cloudflare/workers-types/experimental'
import type { EmailTransport } from './email/types'
import { requireAdmissionBindings } from './admission'
import { requestDiagnostic, safeLimitDiagnostic } from './diagnostics'
export type { SafeEvent } from '../src/account/protocol'

export interface ServiceRuntime {
  now(): number
  emit(event: SafeEvent): void
  fail?(stage: string): void
  runJobs?(): Promise<void>
  emailTransport?: EmailTransport
}
export interface ServiceEnv {
  CLOUD_NETWORK_LIMITER?: RateLimit
  CLOUD_ACCOUNT_LIMITER?: RateLimit
  CLOUD_AUTH_LIMITER?: RateLimit
  CLOUD_LOCATION_LIMITER?: RateLimit
  CLOUD_DAILY_REQUEST_BUDGET?: string
  CLOUD_MONTHLY_REQUEST_BUDGET?: string
  CLOUD_DAILY_WORK_BUDGET?: string
  CLOUD_MONTHLY_WORK_BUDGET?: string
  ADMIN_ACCESS_CONFIG?: string
  SERVICE_BACKUP_KEY?: string
  SERVICE_BACKUP_POLICY?: string
  DB?: D1Database
  OBJECTS?: R2Bucket
  LEDGER_BACKUPS?: R2Bucket
  REVOCATION_LEDGER?: R2Bucket
  EMAIL?: Fetcher
  NATIVE_EMAIL?: SendEmail
  EMAIL_FROM?: string
  EMAIL_STATE_SECRET?: string
  EMAIL_SENDING_ACTIVE?: string
  EMAIL_HEADROOM?: string
  ASSETS?: Fetcher
  ACCOUNTS_ACTIVE?: string
  SIGNUP_ACTIVE?: string
  SERVICE_ORIGIN?: string
  STORAGE_CAP_BYTES?: string
  DUMMY_IDENTITY_SECRET?: string
  OPAQUE_SERVER_SETUP?: string
  SESSION_SECRET?: string
  CURSOR_SECRET?: string
  CAPABILITY_SECRET?: string
}
export type PreparedServiceEnv = ServiceEnv & Required<Pick<ServiceEnv, 'DB' | 'OBJECTS' | 'LEDGER_BACKUPS' | 'SERVICE_ORIGIN' | 'STORAGE_CAP_BYTES' | 'SESSION_SECRET' | 'CURSOR_SECRET' | 'CAPABILITY_SECRET' | 'DUMMY_IDENTITY_SECRET' | 'OPAQUE_SERVER_SETUP'>>
export function requireServiceBindings(env: ServiceEnv): PreparedServiceEnv {
  let validOrigin = false
  try { validOrigin = new URL(env.SERVICE_ORIGIN ?? '').origin === env.SERVICE_ORIGIN } catch { /* Missing origins fail closed */ }
  const secrets = [env.SESSION_SECRET, env.CURSOR_SECRET, env.CAPABILITY_SECRET, env.DUMMY_IDENTITY_SECRET]
  // Email readiness gates signup and email operations, not existing login or sync
  if (env.ACCOUNTS_ACTIVE !== 'true' || !env.DB || !env.OBJECTS || !env.LEDGER_BACKUPS || !validOrigin || !secrets.every(secret => base64urlSchema(digestBytes).safeParse(secret).success) || !OpaqueFieldSchemas.setup.safeParse(env.OPAQUE_SERVER_SETUP).success || new Set(secrets).size !== secrets.length || !/^\d+$/.test(env.STORAGE_CAP_BYTES ?? '') || !Number.isSafeInteger(Number(env.STORAGE_CAP_BYTES)) || Number(env.STORAGE_CAP_BYTES) <= 0) throw new ApiFailure('SERVICE_UNAVAILABLE')
  requireAdmissionBindings(env)
  return env as PreparedServiceEnv
}
export interface ServiceContext {
  readonly env: ServiceEnv
  now(): number
  readonly requestId: string
  emit(event: SafeEvent): void
  checkpoint(stage: string): void
  readonly emailTransport?: EmailTransport
}
const maxEventTextCharacters = 128
const textFields = ['operation', 'stage', 'code', 'jobId', 'mutationId'] as const
const numberFields = ['durationMs', 'attempt', 'bytes', 'rowsRead', 'rowsWritten'] as const
// Phase names are authored identifiers, bounded to 64 ASCII characters and never request values
export const servicePhaseIdentifier = /^[a-z][a-z0-9_.:-]{0,63}$/
export function createServiceContext(request: Request, env: ServiceEnv, runtime?: ServiceRuntime): ServiceContext {
  const requestId = crypto.randomUUID()
  const now = () => runtime?.now() ?? Date.now()
  const startedAt = now()
  const emit = (event: SafeEvent) => {
    // Copy only explicitly allowed bounded telemetry, even when callers spread unsafe objects
    const safe: Record<string, string | number> = {}
    for (const key of textFields) if (typeof event[key] === 'string') safe[key] = event[key].slice(0, maxEventTextCharacters)
    for (const key of numberFields) if (typeof event[key] === 'number' && Number.isFinite(event[key]) && event[key] >= 0) safe[key] = event[key]
    Object.assign(safe, safeLimitDiagnostic(event as unknown as Record<string, unknown>))
    if (event.code) Object.assign(safe, requestDiagnostic(request))
    const bounded = safe as unknown as SafeEvent
    if (runtime) runtime.emit(bounded)
    else console.log(JSON.stringify({ requestId, ...safe }))
  }
  return {
    env, requestId, now, emit, emailTransport: runtime?.emailTransport,
    checkpoint(stage) {
      if (!servicePhaseIdentifier.test(stage)) throw new Error('Invalid service phase identifier')
      emit({ operation: 'checkpoint', stage, durationMs: Math.max(0, now() - startedAt) })
      runtime?.fail?.(stage)
    },
  }
}
