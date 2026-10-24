import type { ServiceContext } from '../context'
import { requireCustomer } from '../auth/session'
import { ApiFailure, jsonResponse } from '../http'
import { serviceRecoveryStatus } from './service-backup'

// Read-only service recovery coverage, not an account export or an operational restore grant
export async function recoveryRoute(request: Request, context: ServiceContext): Promise<Response | null> {
  const url = new URL(request.url)
  if (url.pathname !== '/api/v1/account/recovery') return null
  if (request.method !== 'GET' || url.search) throw new ApiFailure('INVALID_REQUEST')
  await requireCustomer(request, context)
  return jsonResponse({ version: 1, ...(await serviceRecoveryStatus(context)) })
}
