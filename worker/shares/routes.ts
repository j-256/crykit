import { OpaqueIdSchema } from '../../src/account/protocol'
import { PublishSnapshotSchema, UpdateSnapshotSchema, StopSharingSchema, shareRequestBytes } from '../../src/account/shares-protocol'
import { requireCustomer } from '../auth/session'
import type { ServiceContext } from '../context'
import { ApiFailure, errorResponse, jsonResponse, readJson } from '../http'
import { limitPublicShareRead } from './rate-limits'
import { ownShares, publicSnapshot, publishSnapshot, stopSharing } from './publication'

export async function sharesRoute(request: Request, context: ServiceContext): Promise<Response | undefined> {
  const url = new URL(request.url), publicPrefix = '/api/public/v1/shares/', privatePrefix = '/api/v1/shares'
  if (!url.pathname.startsWith(publicPrefix) && url.pathname !== privatePrefix && !url.pathname.startsWith(`${privatePrefix}/`)) return
  let response: Response
  try {
    if (url.pathname.startsWith(publicPrefix)) {
      const id = OpaqueIdSchema.safeParse(url.pathname.slice(publicPrefix.length))
      if (request.method !== 'GET' || !id.success || url.search) throw new ApiFailure('NOT_FOUND')
      await limitPublicShareRead(request, context)
      response = jsonResponse(await publicSnapshot(id.data, context))
    } else {
      const principal = await requireCustomer(request, context)
      if (url.pathname === privatePrefix && request.method === 'GET') {
        const after = url.searchParams.get('after')
        if ([...url.searchParams.keys()].some(key => key !== 'after') || url.searchParams.getAll('after').length > 1 || (after !== null && !OpaqueIdSchema.safeParse(after).success)) throw new ApiFailure('INVALID_REQUEST')
        response = jsonResponse(await ownShares(principal, after, context))
      } else if (url.pathname === privatePrefix && request.method === 'POST' && !url.search) {
        response = jsonResponse(await publishSnapshot(principal, await readJson(request, PublishSnapshotSchema, shareRequestBytes), context))
      } else {
        const id = OpaqueIdSchema.safeParse(url.pathname.slice(privatePrefix.length + 1))
        if (!id.success || url.search) throw new ApiFailure('NOT_FOUND')
        if (request.method === 'PATCH') response = jsonResponse(await publishSnapshot(principal, await readJson(request, UpdateSnapshotSchema, shareRequestBytes), context, id.data))
        else if (request.method === 'DELETE') response = jsonResponse(await stopSharing(principal, id.data, await readJson(request, StopSharingSchema, 1024), context))
        else throw new ApiFailure('NOT_FOUND')
      }
    }
  } catch (error) {
    context.emit({ operation: 'shares', stage: 'route', code: error instanceof ApiFailure ? error.code : 'SERVICE_UNAVAILABLE' })
    response = errorResponse(error, context.requestId)
  }
  response.headers.set('x-robots-tag', 'noindex, nofollow, noarchive')
  return response
}
