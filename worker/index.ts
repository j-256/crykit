import { storageRoute } from './sync/cleanup'
export { previewAdminCommand, executeAdminCommand } from './admin/commands'
import { adminRoute } from './admin/session'
export { requireOperator } from './admin/session'
import { recoveryRoute } from './jobs/recovery-routes'
import { requireRecoveryOpen } from './jobs/service-restore'
import { runServiceJobs, maxServiceJobs } from './jobs/runner'
import { deletionRoute } from './jobs/deletion'
export { beginDeletion } from './jobs/deletion'
import { syncRoute } from './sync/routes'
import { sharesRoute } from './shares/routes'
import { authRoute } from './auth/routes'
export { requireCustomer, requireRecent, assertCustomerWrite } from './auth/session'
import { createServiceContext, requireServiceBindings, type ServiceEnv, type ServiceRuntime } from './context'
import { ApiFailure, errorResponse, jsonResponse } from './http'
import { dispatchEmailJobs, maxEmailDispatchJobs } from './email/jobs'
import { serviceEmailAvailable } from './email/native'
import { AdmissionDenied, admitCloudRequest, admitIngress, reportAdmissionDenied } from './admission'

export async function handleRequest(request: Request, env: ServiceEnv, _execution: ExecutionContext, runtime?: ServiceRuntime): Promise<Response> {
  const context = createServiceContext(request, env, runtime)
  try {
    const url = new URL(request.url)
    if (url.pathname === '/api/admin/v1/bootstrap' || url.pathname === '/admin/bootstrap')
      throw new ApiFailure('NOT_FOUND')
    if (
      url.pathname === '/admin' ||
      url.pathname.startsWith('/admin/') ||
      url.pathname === '/api/admin/v1' ||
      url.pathname.startsWith('/api/admin/v1/')
    ) {
      requireServiceBindings(env)
      await requireRecoveryOpen(context)
      if (url.origin !== env.SERVICE_ORIGIN) throw new ApiFailure('FORBIDDEN')
      return await adminRoute(request, context)
    }
    if (url.pathname === '/api/v1/service' && request.method === 'GET') {
      let accountsAvailable = false
      try { requireServiceBindings(env); await admitIngress(request, context); await admitCloudRequest(context); accountsAvailable = true } catch (error) {
        if (error instanceof AdmissionDenied && error.code === 'RATE_LIMITED') throw error
        if (error instanceof AdmissionDenied) reportAdmissionDenied(error, context)
        // Cloud admission failure leaves guest startup available
      }
      return jsonResponse({ version: 1, accountsAvailable, signupAvailable: accountsAvailable && env.SIGNUP_ACTIVE === 'true' && serviceEmailAvailable(context) && !!await env.DB!.prepare("SELECT 1 FROM service_settings WHERE id='service' AND registration_paused=0").first(), supportedWireVersions: [1] })
    }
    if (url.pathname.startsWith('/api/')) {
      requireServiceBindings(env)
      await admitIngress(request, context)
      await admitCloudRequest(context)
      const response = await storageRoute(request, context) ?? await recoveryRoute(request, context) ?? await deletionRoute(request, context) ?? await sharesRoute(request, context) ?? await authRoute(request, context) ?? await syncRoute(request, context)
      if (response) return response
      // API access never falls back to assets or accepts synthetic identity
      throw new ApiFailure('AUTH_REQUIRED')
    }
    if (env.ASSETS) return await env.ASSETS.fetch(request)
    throw new ApiFailure('NOT_FOUND')
  } catch (error) {
    if (error instanceof AdmissionDenied) reportAdmissionDenied(error, context)
    else context.emit({ operation: 'request', stage: 'route', code: error instanceof ApiFailure ? error.code : 'SERVICE_UNAVAILABLE' })
    const response = errorResponse(error, context.requestId)
    if (new URL(request.url).pathname.startsWith('/api/public/')) response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive')
    return response
  }
}
export async function runScheduled(env: ServiceEnv, runtime?: ServiceRuntime): Promise<void> {
  if (env.ACCOUNTS_ACTIVE !== 'true') return
  requireServiceBindings(env)
  const context = createServiceContext(new Request('https://service.invalid'), env, runtime)
  try { await admitCloudRequest(context) } catch (error) {
    if (!(error instanceof AdmissionDenied)) throw error
    // Pause before leasing a queued job, so the same email or cleanup can resume later
    reportAdmissionDenied(error, context)
    return
  }
  let failed = false
  try { await dispatchEmailJobs(context, maxEmailDispatchJobs) } catch {
    context.emit({ operation: 'email', stage: 'dispatch', code: 'SERVICE_UNAVAILABLE' })
    failed = true
  }
  try { await runServiceJobs(context, maxServiceJobs) } catch {
    context.emit({ operation: 'sync', stage: 'cleanup', code: 'SERVICE_UNAVAILABLE' })
    failed = true
  }
  if (failed) throw new ApiFailure('SERVICE_UNAVAILABLE')
}

// Production entrypoints never supply a local runtime or fixture controls
export default {
  fetch: (request: Request, env: ServiceEnv, execution: ExecutionContext) => handleRequest(request, env, execution),
  scheduled: (_event: ScheduledController, env: ServiceEnv) => runScheduled(env),
}
