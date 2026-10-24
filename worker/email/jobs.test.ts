import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createServiceContext, type ServiceContext } from '../context'
import { runGuardedBatch } from '../db/guarded-batch'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'
import { dispatchEmailJobs, emailInvalidationStatement, enqueueServiceEmail, getEmailJob, prepareServiceEmailEnqueue, resendServiceEmail, retryEmailJob } from './jobs'
import { EmailSendFailure, nativeEmailTransport } from './native'
import { renderServiceEmail } from './templates'
import type { EmailTransport, ServiceEmail } from './types'

const fixtures: ServiceFixture[] = []
const now = 1_800_000_000_000
const capability = randomBytes(32).toString('base64url')
const id = () => randomBytes(16).toString('base64url')
const message = (kind: ServiceEmail['kind'] = 'verify-account'): ServiceEmail => ({ kind, recipient: 'synthetic@example.org', correlationId: 'synthetic-request', ...(kind === 'security-notice' ? {} : { capability, expiresAt: now + 3_600_000 }) })
async function setup(transport: EmailTransport = { async send() { return { messageId: 'synthetic-accepted' } } }) {
  const fixture = await createServiceFixture({ now })
  fixtures.push(fixture)
  let clock = now
  const events: unknown[] = []
  const context = createServiceContext(new Request('http://127.0.0.1'), {
    DB: fixture.db, SERVICE_ORIGIN: 'http://127.0.0.1', ACCOUNTS_ACTIVE: 'true',
    EMAIL_STATE_SECRET: randomBytes(32).toString('base64url'), EMAIL_SENDING_ACTIVE: 'true', EMAIL_HEADROOM: 'available',
  }, { now: () => clock, emit: event => { events.push(event) }, emailTransport: transport })
  return { fixture, context, events, advance: (ms: number) => { clock += ms } }
}
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose())) })

// Real D1 persists each boundary; only the external provider is controlled locally
// Removing the lease guard, preserving plaintext, or retrying ambiguous sends breaks these cases
describe('durable transactional email', () => {
  it('leasesSendOncePerAttemptAndBoundsAutomaticRetries', async ({ annotate }) => {
    let sends = 0
    const { context, fixture, advance } = await setup({ async send() { sends++; throw new EmailSendFailure('RATE_LIMITED', 'retryable', 2) } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await Promise.all([dispatchEmailJobs(context, 10), dispatchEmailJobs(context, 10)])
    expect(sends).toBe(1)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'waiting', delivery: 'unsent', attempts: 1, nextAttemptAt: now + 2000 })
    await dispatchEmailJobs(context, 10)
    expect(sends).toBe(1)
    for (let i = 0; i < 4; i++) { advance(120_000); await dispatchEmailJobs(context, 10) }
    expect(sends).toBe(3)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'failed', attempts: 3, delivery: 'unsent' })
    await expect(retryEmailJob(jobId, context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const attempts = (await fixture.db.prepare('SELECT attempt, delivery FROM email_attempts ORDER BY attempt').all()).results
    expect(attempts).toEqual([{ attempt: 1, delivery: 'unsent' }, { attempt: 2, delivery: 'unsent' }, { attempt: 3, delivery: 'unsent' }])
    expect((await fixture.db.prepare('SELECT * FROM transaction_guards').all()).results).toEqual([])
    await annotate(JSON.stringify({ concurrentLeaseWinners: 1, automaticAttempts: sends, attempts }), 'D1 observation')
  })

  it('acceptedIsNotDelivered', async () => {
    const { context, fixture, events } = await setup()
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    const retained = JSON.stringify((await fixture.db.prepare('SELECT * FROM email_jobs').all()).results)
    expect(retained).not.toContain(capability)
    expect(retained).not.toContain('synthetic@example.org')
    await dispatchEmailJobs(context, 1)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'complete', delivery: 'accepted', attempts: 1 })
    expect(JSON.stringify(events)).not.toContain(capability)
    expect(JSON.stringify(events)).not.toContain('synthetic@example.org')
    expect(JSON.stringify(events)).not.toContain('synthetic-accepted')
  })

  it('uncertainSuppressedPausedAndExpiredJobsStayHonest', async () => {
    let sends = 0
    const { context, advance } = await setup({ async send() { sends++; throw new Error(`Lost response ${capability} synthetic@example.org`) } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ delivery: 'uncertain', state: 'failed', attempts: 1 })
    await expect(retryEmailJob(jobId, context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    advance(120_000)
    await dispatchEmailJobs(context, 10)
    expect(sends).toBe(1)
    const expired = id()
    await enqueueServiceEmail({ ...message(), expiresAt: now }, expired, context)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(expired, context)).toMatchObject({ delivery: 'expired', state: 'failed', attempts: 0 })
    expect(sends).toBe(1)
    await expect(resendServiceEmail(expired, id(), context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('coalescesConcurrentEnqueueAndRejectsMismatchedRequests', async () => {
    const { context, fixture } = await setup()
    const jobId = id()
    const receipts = await Promise.all([enqueueServiceEmail(message(), jobId, context), enqueueServiceEmail({ ...message(), correlationId: 'another-request' }, jobId, context)])
    expect(receipts[0]).toEqual(receipts[1])
    expect((await fixture.db.prepare('SELECT id FROM email_jobs').all()).results).toHaveLength(1)
    await expect(enqueueServiceEmail({ ...message(), recipient: 'other@example.net' }, jobId, context)).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' })
  })

  it('coalescesOneExplicitResendWithoutErasingUncertaintyOrPermittingChains', async () => {
    const { context, fixture } = await setup({ async send() { throw new Error('Lost native response') } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await dispatchEmailJobs(context, 10)
    const receipts = await Promise.all([resendServiceEmail(jobId, id(), context), resendServiceEmail(jobId, id(), context)])
    expect(receipts[0].jobId).toBe(receipts[1].jobId)
    expect(await getEmailJob(jobId, context)).toMatchObject({ delivery: 'uncertain', attempts: 1 })
    await dispatchEmailJobs(context, 10)
    await expect(resendServiceEmail(receipts[0].jobId, id(), context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect((await fixture.db.prepare('SELECT id FROM email_jobs').all()).results).toHaveLength(2)
  })

  it('retriesOnlyKnownUnsentFailuresAndKeepsCumulativeHistory', async () => {
    const { context } = await setup({ async send() { throw new EmailSendFailure('SENDER_UNAVAILABLE', 'permanent') } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ attempts: 1, delivery: 'unsent', state: 'failed' })
    await retryEmailJob(jobId, context)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ attempts: 2, delivery: 'unsent', state: 'failed' })
  })

  it('stopsSuppressionAndNeverAutomaticallyRestartsIt', async () => {
    const { context } = await setup({ async send() { throw new EmailSendFailure('RECIPIENT_SUPPRESSED', 'suppressed') } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await dispatchEmailJobs(context, 10)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'failed', delivery: 'suppressed', attempts: 1 })
    await expect(retryEmailJob(jobId, context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(resendServiceEmail(jobId, id(), context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it.each(['paused', 'unknown-headroom', 'binding-unavailable'])('keeps %s waiting without spending an attempt', async boundary => {
    let sends = 0
    const { context } = await setup({ async send() { sends++; return { messageId: 'synthetic-accepted' } } })
    const blocked: ServiceContext = { ...context, env: { ...context.env, ...(boundary === 'paused' ? { EMAIL_SENDING_ACTIVE: 'false' } : boundary === 'unknown-headroom' ? { EMAIL_HEADROOM: 'unknown' } : {}) }, ...(boundary === 'binding-unavailable' ? { emailTransport: undefined } : {}) }
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, blocked)
    await dispatchEmailJobs(blocked, 10)
    expect(await getEmailJob(jobId, blocked)).toMatchObject({ state: 'waiting', delivery: 'paused', attempts: 0 })
    expect(sends).toBe(0)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ delivery: 'accepted', attempts: 1 })
  })

  it('drainsLaterSafetyWorkAndPendingPausesBehindAnOversizedPausedBacklog', async () => {
    let sends = 0
    const { context, fixture, advance } = await setup({ async send() { sends++; return { messageId: 'synthetic-accepted' } } })
    const paused: ServiceContext = { ...context, env: { ...context.env, EMAIL_HEADROOM: 'unknown' } }
    const older = Array.from({ length: 5 }, id)
    for (const jobId of older) await enqueueServiceEmail(message(), jobId, context)
    await dispatchEmailJobs(paused, 2)
    advance(1)
    const inFlight = id(), expired = id(), invalidated = id(), laterPending = id()
    await enqueueServiceEmail(message(), inFlight, context)
    // Real D1 records the external-effect boundary before the process disappears
    await fixture.db.batch([
      fixture.db.prepare("UPDATE email_jobs SET state = 'running', attempts = 1, lease_token = 'lost-lease', lease_until = ? WHERE id = ?").bind(now + 60_000, inFlight),
      fixture.db.prepare("INSERT INTO email_attempts (job_id, attempt, lease_token, delivery, started_at) VALUES (?, 1, 'lost-lease', 'sending', ?)").bind(inFlight, now),
    ])
    await enqueueServiceEmail({ ...message(), expiresAt: now + 2 }, expired, context)
    await enqueueServiceEmail(message(), invalidated, context)
    await emailInvalidationStatement(fixture.db, invalidated).run()
    await enqueueServiceEmail(message(), laterPending, context)
    advance(120_000)
    await dispatchEmailJobs(paused, 2)
    // Safety transitions take the bounded batch before ordinary sender work
    expect(await fixture.db.prepare("SELECT COUNT(*) AS count FROM email_jobs WHERE state = 'failed'").first('count')).toBe(2)
    await dispatchEmailJobs(paused, 2)
    expect(await getEmailJob(inFlight, context)).toMatchObject({ state: 'failed', delivery: 'uncertain', attempts: 1 })
    expect(await getEmailJob(expired, context)).toMatchObject({ state: 'failed', delivery: 'expired', attempts: 0 })
    expect(await getEmailJob(invalidated, context)).toMatchObject({ state: 'failed', delivery: 'cancelled', attempts: 0 })
    for (let pass = 0; pass < 5; pass++) await dispatchEmailJobs(paused, 2)
    for (const jobId of [...older, laterPending]) expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'waiting', delivery: 'paused', attempts: 0 })
    expect(sends).toBe(0)
    expect(await fixture.db.prepare('SELECT delivery FROM email_attempts WHERE job_id = ?').bind(inFlight).first('delivery')).toBe('uncertain')
    const auditBefore = await fixture.db.prepare('SELECT COUNT(*) AS count FROM email_audit').first('count')
    await dispatchEmailJobs(paused, 2)
    expect(await fixture.db.prepare('SELECT COUNT(*) AS count FROM email_audit').first('count')).toBe(auditBefore)
  })

  it('rollsBackEnqueueAndClaimWhenDurableAuditFails', async () => {
    let sends = 0
    const { context, fixture } = await setup({ async send() { sends++; return { messageId: 'synthetic-accepted' } } })
    const jobId = id()
    await fixture.db.exec("CREATE TRIGGER fail_email_audit BEFORE INSERT ON email_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;")
    await expect(enqueueServiceEmail(message(), jobId, context)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect((await fixture.db.prepare('SELECT * FROM email_jobs').all()).results).toEqual([])
    await fixture.db.exec('DROP TRIGGER fail_email_audit')
    await enqueueServiceEmail(message(), jobId, context)
    await fixture.db.exec("CREATE TRIGGER fail_email_audit BEFORE INSERT ON email_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;")
    await expect(dispatchEmailJobs(context, 10)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(sends).toBe(0)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'queued', attempts: 0 })
    expect((await fixture.db.prepare('SELECT * FROM email_attempts').all()).results).toEqual([])
  })

  it('keepsAcceptedButUnpersistedResultUncertainAfterLeaseRecovery', async ({ annotate }) => {
    let sends = 0
    const { context, fixture, advance } = await setup({ async send() {
      sends++
      await fixture.db.exec("CREATE TRIGGER fail_email_result BEFORE UPDATE ON email_jobs WHEN NEW.delivery = 'accepted' BEGIN SELECT RAISE(ABORT, 'synthetic result failure'); END;")
      return { messageId: 'synthetic-accepted' }
    } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await expect(dispatchEmailJobs(context, 10)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'running', attempts: 1 })
    await fixture.db.exec('DROP TRIGGER fail_email_result')
    await emailInvalidationStatement(fixture.db, jobId).run()
    advance(3_600_000)
    await dispatchEmailJobs(context, 10)
    const status = await getEmailJob(jobId, context)
    expect(status).toMatchObject({ state: 'failed', delivery: 'uncertain', attempts: 1 })
    expect(sends).toBe(1)
    await annotate(JSON.stringify({ sends, status, attempts: (await fixture.db.prepare('SELECT delivery FROM email_attempts').all()).results }), 'D1 recovery observation')
  })

  it('rejectsMissingSeparateServiceSecretAndTamperedCiphertextWithoutSending', async () => {
    const { context, fixture } = await setup()
    await expect(enqueueServiceEmail(message(), id(), { ...context, env: { ...context.env, EMAIL_STATE_SECRET: undefined } })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(enqueueServiceEmail(message(), id(), { ...context, env: { ...context.env, SESSION_SECRET: context.env.EMAIL_STATE_SECRET } })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    await expect(enqueueServiceEmail(message(), id(), { ...context, env: { ...context.env, DUMMY_IDENTITY_SECRET: context.env.EMAIL_STATE_SECRET } })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await fixture.db.prepare("UPDATE email_jobs SET payload = 'corrupt' WHERE id = ?").bind(jobId).run()
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'failed', delivery: 'unsent', code: 'PAYLOAD_UNAVAILABLE' })
  })

  it('invalidatesKnownUnsentRootAndResendLineageAcrossRealD1Boundaries', async () => {
    let sends = 0
    const { context, fixture } = await setup({ async send() { sends++; return { messageId: 'synthetic-accepted' } } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await emailInvalidationStatement(fixture.db, jobId).run()
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ delivery: 'cancelled', attempts: 0 })
    expect(sends).toBe(0)
    const acceptedId = id()
    await enqueueServiceEmail(message(), acceptedId, context)
    await dispatchEmailJobs(context, 10)
    const resent = await resendServiceEmail(acceptedId, id(), context)
    await emailInvalidationStatement(fixture.db, acceptedId).run()
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(acceptedId, context)).toMatchObject({ delivery: 'accepted', attempts: 1 })
    expect(await getEmailJob(resent.jobId, context)).toMatchObject({ delivery: 'cancelled', attempts: 0 })
    await expect(retryEmailJob(resent.jobId, context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(sends).toBe(1)
  })

  it('checksEligibilityAgainBeforeSendStartAndPreservesAlreadyStartedAcceptance', async () => {
    let sends = 0
    const { context, fixture } = await setup({ async send() { sends++; await emailInvalidationStatement(fixture.db, startedId).run(); return { messageId: 'synthetic-accepted' } } })
    const cancelledId = id()
    await enqueueServiceEmail(message(), cancelledId, context)
    await fixture.db.exec("CREATE TRIGGER invalidate_after_lease AFTER INSERT ON email_attempts BEGIN UPDATE email_jobs SET eligible = 0 WHERE id = NEW.job_id; END;")
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(cancelledId, context)).toMatchObject({ delivery: 'cancelled', attempts: 1 })
    expect(sends).toBe(0)
    await fixture.db.exec('DROP TRIGGER invalidate_after_lease')
    const startedId = id()
    await enqueueServiceEmail(message(), startedId, context)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(startedId, context)).toMatchObject({ delivery: 'accepted', attempts: 1 })
    expect(sends).toBe(1)
  })

  it('serializesConcurrentResendAndRootInvalidationWithoutAnEligibleEscapedChild', async () => {
    let sends = 0
    const { context, fixture } = await setup({ async send() { sends++; return { messageId: 'synthetic-accepted' } } })
    const root = id()
    await enqueueServiceEmail(message(), root, context)
    await dispatchEmailJobs(context, 10)
    const outcomes = await Promise.allSettled([resendServiceEmail(root, id(), context), emailInvalidationStatement(fixture.db, root).run()])
    expect(outcomes[1].status).toBe('fulfilled')
    await dispatchEmailJobs(context, 10)
    expect(sends).toBe(1)
    const children = (await fixture.db.prepare('SELECT delivery, eligible FROM email_jobs WHERE resend_of = ?').bind(root).all()).results
    expect(children.every(child => child.delivery === 'cancelled' && child.eligible === 0)).toBe(true)
    await expect(resendServiceEmail(root, id(), context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('treatsExpiredUnstartedLeaseAsKnownUnsentAndNeverAsCancellation', async () => {
    let sends = 0
    const { context, advance } = await setup({ async send() { sends++; return { messageId: 'synthetic-accepted' } } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await dispatchEmailJobs({ ...context, checkpoint(stage) { if (stage === 'email.before-send') advance(120_000) } }, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ delivery: 'unsent', state: 'waiting', attempts: 1 })
    expect(sends).toBe(0)
  })

  it('rechecksObservedAttemptStageInsideLeaseRecoveryTransaction', async () => {
    const { context, fixture, advance } = await setup()
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    // An actual persisted lease simulates the process dying before send-start
    await fixture.db.batch([
      fixture.db.prepare("UPDATE email_jobs SET state = 'running', attempts = 1, lease_token = 'synthetic-lease', lease_until = ? WHERE id = ?").bind(now + 60_000, jobId),
      fixture.db.prepare("INSERT INTO email_attempts (job_id, attempt, lease_token, delivery, started_at) VALUES (?, 1, 'synthetic-lease', 'leased', ?)").bind(jobId, now),
    ])
    advance(120_000)
    let interleaved = false
    // Keep real D1 reads/writes; interleave a competing send-start after the
    // recovery snapshot so only the transaction's stage predicate can protect it
    const db = new Proxy(fixture.db, { get(target, key) {
      if (key !== 'prepare') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value }
      return (sql: string) => {
        const statement = target.prepare(sql)
        if (sql !== 'SELECT delivery FROM email_attempts WHERE job_id = ? AND attempt = ?') return statement
        return new Proxy(statement, { get(prepared, member) {
          if (member === 'bind') return (...bindings: unknown[]) => {
            const bound = prepared.bind(...bindings)
            return new Proxy(bound, { get(actual, field) {
              if (field === 'first') return async () => {
                const observed = await actual.first()
                if (!interleaved) { interleaved = true; await fixture.db.prepare("UPDATE email_attempts SET delivery = 'sending' WHERE job_id = ? AND attempt = 1").bind(jobId).run() }
                return observed
              }
              const value = Reflect.get(actual, field); return typeof value === 'function' ? value.bind(actual) : value
            } })
          }
          const value = Reflect.get(prepared, member); return typeof value === 'function' ? value.bind(prepared) : value
        } })
      }
    } })
    await dispatchEmailJobs({ ...context, env: { ...context.env, DB: db } }, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'running', attempts: 1 })
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'failed', delivery: 'uncertain', attempts: 1 })
  })

  it('doesNotEmitAcceptanceWhenAConcurrentLeaseRecoveryWins', async () => {
    const { context, events, advance } = await setup({ async send() {
      advance(120_000)
      await dispatchEmailJobs(context, 10)
      return { messageId: 'late-accepted' }
    } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ delivery: 'uncertain', state: 'failed' })
    expect(events).not.toContainEqual(expect.objectContaining({ stage: 'accepted' }))
  })

  it('pausesDeactivatedAccountsServiceAndRejectsMalformedTransportAcceptance', async () => {
    const { context } = await setup({ async send() { return { messageId: '' } } })
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    await dispatchEmailJobs({ ...context, env: { ...context.env, ACCOUNTS_ACTIVE: 'false' } }, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'waiting', delivery: 'paused', attempts: 0 })
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'failed', delivery: 'uncertain', attempts: 1 })
  })

  it('honorsCapturedHttpRetryAfterAndQuotaWithoutOutboundNetworkMessages', async () => {
    const fixture = await createServiceFixture({ now, emailResponses: [{ status: 429, retryAfter: '120' }, { status: 429, code: 'QUOTA_LIMITED', retryAfter: new Date(now + 3_600_000).toUTCString() }] })
    fixtures.push(fixture)
    const jobId = id()
    const post = (path: string, body: unknown) => fixture.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post('/__accounts/email/enqueue', { jobId, message: message() })).status).toBe(200)
    await fixture.runJobs()
    expect(await (await post('/__accounts/email/status', { jobId })).json()).toMatchObject({ state: 'waiting', attempts: 1, nextAttemptAt: now + 120_000, code: 'RATE_LIMITED' })
    fixture.advance(119_999)
    await fixture.runJobs()
    expect(await fixture.emails()).toHaveLength(0)
    fixture.advance(1)
    await fixture.runJobs()
    expect(await (await post('/__accounts/email/status', { jobId })).json()).toMatchObject({ state: 'waiting', attempts: 2, nextAttemptAt: now + 3_600_000, code: 'QUOTA_LIMITED' })
    fixture.advance(3_480_000)
    await fixture.runJobs()
    // Capability expiry wins over a quota delay becoming due
    expect(await (await post('/__accounts/email/status', { jobId })).json()).toMatchObject({ delivery: 'expired', attempts: 2 })
    expect(await fixture.emails()).toHaveLength(0)
    expect(fixture.emailCaptureStats().outboundNetworkMessages).toBe(0)
  })

  it('erasesExpiredPayloadAndPrunesEmailAuditAtItsRetentionHorizon', async () => {
    const { context, fixture, advance } = await setup()
    const root = id()
    await enqueueServiceEmail(message(), root, context)
    await dispatchEmailJobs(context, 10)
    const child = await resendServiceEmail(root, id(), context)
    await dispatchEmailJobs(context, 10)
    advance(3_600_000)
    await dispatchEmailJobs(context, 10)
    expect((await fixture.db.prepare('SELECT payload FROM email_jobs').all()).results).toEqual([{ payload: null }, { payload: null }])
    expect((await fixture.db.prepare('SELECT * FROM email_audit').all()).results.length).toBeGreaterThan(0)
    advance(91 * 24 * 60 * 60 * 1000)
    await dispatchEmailJobs(context, 10)
    expect((await fixture.db.prepare('SELECT * FROM email_audit').all()).results).toEqual([])
    expect((await fixture.db.prepare('SELECT * FROM email_attempts').all()).results).toEqual([])
    expect((await fixture.db.prepare('SELECT id FROM email_jobs WHERE id IN (?, ?)').bind(root, child.jobId).all()).results).toEqual([])
  })

  it('preservesTheRootImplicitSecurityNoticeExpiryOnExplicitResend', async () => {
    const { context, advance } = await setup()
    const root = id()
    await enqueueServiceEmail(message('security-notice'), root, context)
    await dispatchEmailJobs(context, 10)
    advance(12 * 60 * 60 * 1000)
    const child = await resendServiceEmail(root, id(), context)
    advance(12 * 60 * 60 * 1000)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(child.jobId, context)).toMatchObject({ delivery: 'expired', attempts: 0 })
  })

  it('neverUsesAnotherLeaseGenerationLoadedAfterItsOwnClaim', async () => {
    const { context, fixture } = await setup()
    const jobId = id()
    await enqueueServiceEmail(message(), jobId, context)
    // A real SQL interleave replaces the owned generation before its reload
    // A failed decrypt must not settle this other generation's in-flight send
    await fixture.db.exec("CREATE TRIGGER replace_claimed_generation AFTER INSERT ON email_attempts WHEN NEW.attempt = 1 BEGIN UPDATE email_jobs SET attempts = 2, lease_token = 'competing-lease', payload = 'corrupt' WHERE id = NEW.job_id; INSERT INTO email_attempts (job_id, attempt, lease_token, delivery, started_at) VALUES (NEW.job_id, 2, 'competing-lease', 'sending', NEW.started_at); END;")
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ state: 'running', attempts: 2 })
    expect(await fixture.db.prepare('SELECT delivery FROM email_attempts WHERE job_id = ? AND attempt = 2').bind(jobId).first('delivery')).toBe('sending')
  })

  it('doesNotShortenRetryAfterWhenTheProviderDelayExceedsTheFallbackWindow', async () => {
    const day = 24 * 60 * 60 * 1000
    let sends = 0
    const { context, advance } = await setup({ async send() { sends++; throw new EmailSendFailure('RATE_LIMITED', 'retryable', 8 * 24 * 3600) } })
    const jobId = id()
    await enqueueServiceEmail({ ...message(), expiresAt: now + 10 * day }, jobId, context)
    await dispatchEmailJobs(context, 10)
    expect(await getEmailJob(jobId, context)).toMatchObject({ nextAttemptAt: now + 8 * day })
    advance(7 * day)
    await dispatchEmailJobs(context, 10)
    expect(sends).toBe(1)
  })

  it('atomicallyComposesAuthorityAndPreparedOutboxAndPreservesExactRetry', async () => {
    const { context, fixture } = await setup()
    await fixture.db.exec('CREATE TABLE email_authority_probe (job_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)')
    const jobId = id()
    const execute = async () => {
      const prepared = await prepareServiceEmailEnqueue(message(), jobId, context)
      await runGuardedBatch(fixture.db, {
        sql: `SELECT (${prepared.guard.sql}) AND NOT EXISTS (SELECT 1 FROM email_authority_probe WHERE job_id = ? AND value != 'synthetic-authority')`,
        bindings: [...prepared.guard.bindings, jobId],
      }, [fixture.db.prepare('INSERT INTO email_authority_probe VALUES (?, ?) ON CONFLICT(job_id) DO NOTHING').bind(jobId, 'synthetic-authority'), ...prepared.statements])
    }
    await execute()
    await dispatchEmailJobs(context, 10)
    const before = (await fixture.db.batch(['email_jobs', 'email_attempts', 'email_audit', 'email_authority_probe'].map(table => fixture.db.prepare(`SELECT * FROM ${table} ORDER BY 1`)))).map(result => result.results)
    await execute()
    const after = (await fixture.db.batch(['email_jobs', 'email_attempts', 'email_audit', 'email_authority_probe'].map(table => fixture.db.prepare(`SELECT * FROM ${table} ORDER BY 1`)))).map(result => result.results)
    expect(after).toEqual(before)
    expect(await getEmailJob(jobId, context)).toMatchObject({ delivery: 'accepted', attempts: 1 })
    const mismatch = await prepareServiceEmailEnqueue({ ...message(), recipient: 'different@example.net' }, jobId, context)
    await expect(runGuardedBatch(fixture.db, mismatch.guard, mismatch.statements)).rejects.toThrow(/CHECK constraint failed/)
    expect(await getEmailJob(jobId, context)).toMatchObject({ delivery: 'accepted', attempts: 1 })
  })

  it.each(['authority', 'outbox', 'audit'])('rollsBackBothAuthorityAndPreparedOutboxWhen %s Fails', async boundary => {
    const { context, fixture } = await setup()
    await fixture.db.exec('CREATE TABLE email_authority_probe (job_id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)')
    const jobId = id()
    const prepared = await prepareServiceEmailEnqueue(message(), jobId, context)
    if (boundary !== 'authority') await fixture.db.exec(`CREATE TRIGGER fail_outbox_probe BEFORE INSERT ON ${boundary === 'outbox' ? 'email_jobs' : 'email_audit'} BEGIN SELECT RAISE(ABORT, 'synthetic outbox failure'); END;`)
    await expect(runGuardedBatch(fixture.db, prepared.guard, [fixture.db.prepare('INSERT INTO email_authority_probe VALUES (?, ?)').bind(jobId, boundary === 'authority' ? null : 'synthetic-authority'), ...prepared.statements])).rejects.toThrow()
    for (const table of ['email_jobs', 'email_audit', 'email_authority_probe', 'transaction_guards']) expect((await fixture.db.prepare(`SELECT * FROM ${table}`).all()).results).toEqual([])
  })

  it('keepsProductionEmailCaptureUnavailableWithoutDisablingExistingAccountService', async () => {
    const fixture = await createServiceFixture({ now })
    fixtures.push(fixture)
    expect(await (await fixture.request('/api/v1/service')).json()).toMatchObject({ accountsAvailable: true, signupAvailable: true })
    expect(await (await fixture.request('/__accounts/production/service')).json()).toMatchObject({ accountsAvailable: true, signupAvailable: false })
    expect((await fixture.request('/__accounts/production/email', { method: 'POST' })).status).toBe(404)
    expect(fixture.emailCaptureStats().outboundNetworkMessages).toBe(0)
  })

  it('rejectsRecipientsOutsideTheExactCaptureAllowlist', async () => {
    const fixture = await createServiceFixture({ now })
    fixtures.push(fixture)
    const jobId = id()
    const response = await fixture.request('/__accounts/email/enqueue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId, message: { ...message(), recipient: 'synthetic@' + ['sub', 'example', 'org'].join('.') } }) })
    expect(response.status).toBe(200)
    await fixture.runJobs()
    const status = await fixture.request('/__accounts/email/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId }) })
    expect(await status.json()).toMatchObject({ state: 'failed', delivery: 'unsent', code: 'RECIPIENT_NOT_ALLOWED' })
    expect(await fixture.emails()).toHaveLength(0)
    expect(fixture.emailCaptureStats().outboundNetworkMessages).toBe(0)
  })

  it('capturesEveryFixedKindLocallyAndDoesNotConsumeLinksOnGet', async () => {
    const fixture = await createServiceFixture({ now })
    fixtures.push(fixture)
    for (const kind of ['verify-account', 'verify-email', 'security-notice', 'admin-invite'] as const) {
      const response = await fixture.request('/__accounts/email/enqueue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jobId: id(), message: message(kind) }) })
      expect(response.status).toBe(200)
    }
    await fixture.runJobs()
    const emails = await fixture.emails()
    expect(fixture.emailCaptureStats().outboundNetworkMessages).toBe(0)
    expect(emails.map(email => email.kind).sort()).toEqual(['admin-invite', 'security-notice', 'verify-account', 'verify-email'])
    const account = renderServiceEmail(message(), 'http://127.0.0.1')
    const email = renderServiceEmail(message('verify-email'), 'http://127.0.0.1')
    const invite = renderServiceEmail(message('admin-invite'), 'http://127.0.0.1')
    expect(account.text).toContain(`http://127.0.0.1/#/account/verify/${capability}`)
    expect(email.text).toContain(`http://127.0.0.1/#/account/confirm-email/${capability}`)
    expect(invite.text).toContain(`http://127.0.0.1/admin/accept-invitation/#${capability}`)
    await fixture.request(`/#/account/verify/${capability}`)
    expect(await fixture.emails()).toHaveLength(4)
    expect((await fixture.db.prepare('SELECT delivery FROM email_jobs').all()).results.every(row => row.delivery === 'accepted')).toBe(true)
    expect(JSON.stringify(fixture.events())).not.toContain(capability)
    expect(JSON.stringify(fixture.events())).not.toContain('synthetic@example.org')
    expect((await fixture.request('/__accounts/production/email', { method: 'POST' })).status).toBe(404)
  })
})

describe('pinned structured native binding boundary', () => {
  it('rejectsInvalidConfiguredSenderBeforeCallingNativeBinding', async () => {
    let called = false
    const transport = nativeEmailTransport({ async send() { called = true; return { messageId: 'synthetic' } } }, 'sender@example.com\r\nBcc: other@example.org', 'https://example.org')
    await expect(transport.send(message())).rejects.toMatchObject({ code: 'SENDER_UNAVAILABLE', disposition: 'permanent' })
    expect(called).toBe(false)
  })

  it('usesFixedSenderTemplateAndOnlyTreatsMessageIdAsAcceptance', async () => {
    const payloads: unknown[] = []
    const transport = nativeEmailTransport({ async send(payload) { payloads.push(payload); return { messageId: 'native-accepted' } } }, 'sender@example.com', 'https://example.org')
    expect(await transport.send(message())).toEqual({ messageId: 'native-accepted' })
    expect(payloads).toEqual([{ from: 'sender@example.com', to: 'synthetic@example.org', subject: 'Verify your Crystal Kit account', text: expect.stringContaining(`https://example.org/#/account/verify/${capability}`) }])
  })

  it.each([
    ['E_RECIPIENT_SUPPRESSED', 'suppressed', 'RECIPIENT_SUPPRESSED'],
    ['E_RATE_LIMIT_EXCEEDED', 'retryable', 'RATE_LIMITED'],
    ['E_DAILY_LIMIT_EXCEEDED', 'retryable', 'QUOTA_LIMITED'],
    ['E_SENDER_NOT_VERIFIED', 'permanent', 'SENDER_UNAVAILABLE'],
    ['E_RECIPIENT_NOT_ALLOWED', 'permanent', 'RECIPIENT_NOT_ALLOWED'],
    ['E_INTERNAL_SERVER_ERROR', 'uncertain', 'TRANSPORT_UNCERTAIN'],
  ])('classifies %s without retaining raw provider errors', async (code, disposition, safeCode) => {
    const transport = nativeEmailTransport({ async send() { throw Object.assign(new Error(`synthetic@example.org ${capability}`), { code }) } }, 'sender@example.com', 'https://example.org')
    try { await transport.send(message()); expect.unreachable() } catch (error) {
      expect(error).toMatchObject({ disposition, code: safeCode })
      expect(String(error)).not.toContain(capability)
    }
  })
})
