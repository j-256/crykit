import { z } from 'zod'
import { DeviceApproveSchema, DeviceCompleteSchema, DeviceRejectSchema, DeviceStartSchema, DeviceStatusInputSchema, OpaqueIdSchema, deviceApprovalLifetimeMs, approvalRequestListLimit, deviceFingerprint, devicePageLimit, maxDeviceCursorCharacters, deviceSecretHash, maxAuthJsonBytes } from '../../src/account/protocol'
import type { ServiceContext } from '../context'
import { ApiFailure, jsonResponse, readJson } from '../http'
import { guarded, keyedHash, normalizedEmail, randomId } from './identity'
import { limitAuth } from './rate-limits'
import { assertOrigin, incomingSessionHash, liveSessionSql, newSession, requireCustomer, sessionResponse, type CustomerPrincipal } from './session'

interface ApprovalRow {
  id: string; account_id: string | null; pairing_context: string; request_public_key: string; capability_hash: string; expires_at: number
  state: 'pending' | 'approved' | 'rejected' | 'consumed'; approver_session_id: string | null; approver_device_id: string | null; completion_hash: string | null; sealed_payload: string | null
}
interface Device { id: string; createdAt: number; revokedAt: number | null }
const deviceCursorLifetimeMs = 10 * 60 * 1000
const CursorSchema = z.tuple([z.number().int().nonnegative(), OpaqueIdSchema, z.number().int().nonnegative()])
export async function devicePage(principal: CustomerPrincipal, context: ServiceContext, cursor: string | null = null) {
  let position: z.infer<typeof CursorSchema> | null = null
  if (cursor !== null) {
    if (cursor.length > maxDeviceCursorCharacters) throw new ApiFailure('INVALID_REQUEST')
    const parts = cursor.split('.')
    if (parts.length !== 2 || await keyedHash(context.env.CURSOR_SECRET, `devices:${principal.accountId}`, parts[0]) !== parts[1]) throw new ApiFailure('INVALID_REQUEST')
    try { position = CursorSchema.parse(JSON.parse(atob(parts[0]))); if (position[2] <= context.now()) throw new Error('Expired cursor') } catch { throw new ApiFailure('INVALID_REQUEST') }
  }
  const db = context.env.DB!
  const currentDevice = await db.prepare('SELECT id, created_at AS createdAt, revoked_at AS revokedAt FROM devices WHERE account_id = ? AND id = ?').bind(principal.accountId, principal.deviceId).first<Device>()
  const rows = await db.prepare(`SELECT id, created_at AS createdAt, revoked_at AS revokedAt FROM devices WHERE account_id = ? ${position ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).bind(principal.accountId, ...(position ? [position[0], position[0], position[1]] : []), devicePageLimit + 1).all<Device>()
  const devices = rows.results.slice(0, devicePageLimit), hasMore = rows.results.length > devicePageLimit
  const last = devices.at(-1)
  // A continuation retains the initial expiry, so reading more pages cannot extend a cursor's life
  const payload = last ? btoa(JSON.stringify([last.createdAt, last.id, position?.[2] ?? context.now() + deviceCursorLifetimeMs])) : ''
  const nextCursor = hasMore ? `${payload}.${await keyedHash(context.env.CURSOR_SECRET, `devices:${principal.accountId}`, payload)}` : null
  return { devices, currentDevice, hasMore, nextCursor }
}
async function approvalMetadata(row: ApprovalRow) {
  const metadata = { accountId: row.account_id!, requestId: row.id, requestPublicKey: row.request_public_key, pairingContext: row.pairing_context, expiresAt: row.expires_at }
  return { ...metadata, fingerprint: await deviceFingerprint(metadata) }
}
async function start(request: Request, context: ServiceContext) {
  const input = await readJson(request, DeviceStartSchema, maxAuthJsonBytes)
  const email = normalizedEmail(input.email)
  await limitAuth(request, `device:${email}`, context, 'start')
  const db = context.env.DB!, now = context.now(), pairingContext = randomId()
  const account = await db.prepare("SELECT id FROM accounts WHERE normalized_email = ? AND access IN ('active','read-only')").bind(email).first<{ id: string }>()
  const expiresAt = now + deviceApprovalLifetimeMs
  // Unknown email has the same fresh receipt and pending row shape, without account authority
  await guarded(context, { sql: 'SELECT NOT EXISTS (SELECT 1 FROM device_approvals WHERE id = ?)', bindings: [input.requestId] }, [
    db.prepare('DELETE FROM device_approvals WHERE expires_at <= ?').bind(now),
    db.prepare('INSERT INTO device_approvals (id, account_id, pairing_context, request_public_key, capability_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)').bind(input.requestId, account?.id ?? null, pairingContext, input.requestPublicKey, input.requestCapabilityHash, expiresAt),
  ])
  return jsonResponse({ requestId: input.requestId, pairingContext, expiresAt })
}
async function status(request: Request, context: ServiceContext) {
  const input = await readJson(request, DeviceStatusInputSchema, maxAuthJsonBytes)
  await limitAuth(request, input.requestId, context, 'device-status')
  const hash = await deviceSecretHash(input.requestCapability)
  const row = await context.env.DB!.prepare('SELECT * FROM device_approvals WHERE id = ? AND capability_hash = ?').bind(input.requestId, hash).first<ApprovalRow>()
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  if (row.account_id && !await context.env.DB!.prepare("SELECT 1 FROM accounts WHERE id = ? AND access <> 'deleting'").bind(row.account_id).first()) return jsonResponse({ state: 'rejected' })
  if (row.expires_at <= context.now()) return jsonResponse({ state: 'expired' })
  return jsonResponse(row.state === 'approved' ? { state: row.state, accountId: row.account_id, sealedPayload: row.sealed_payload } : { state: row.state })
}
async function complete(request: Request, context: ServiceContext) {
  const input = await readJson(request, DeviceCompleteSchema, maxAuthJsonBytes)
  await limitAuth(request, input.requestId, context, 'device-complete')
  const db = context.env.DB!, now = context.now()
  const capabilityHash = await deviceSecretHash(input.requestCapability), completionHash = await deviceSecretHash(input.completionSecret)
  const row = await db.prepare('SELECT * FROM device_approvals WHERE id = ?').bind(input.requestId).first<ApprovalRow>()
  if (!row?.account_id) throw new ApiFailure('INVALID_REQUEST')
  const deviceId = randomId(), prepared = await newSession(row.account_id, deviceId, input.remember, context)
  const incomingHash = await incomingSessionHash(request, context)
  context.checkpoint('auth.devices.complete.before-batch')
  // Approval is delegated live session authority, never a durable bypass after account/device revocation
  // Consumption and both inserts share D1's transaction, so failed issuance leaves no partial device
  await guarded(context, {
    sql: `SELECT EXISTS (${liveSessionSql} AND a.verified_at IS NOT NULL) AND EXISTS (SELECT 1 FROM device_approvals WHERE id = ? AND account_id = ? AND state = 'approved' AND expires_at > ? AND capability_hash = ? AND completion_hash = ? AND approver_session_id = ? AND approver_device_id = ?)`,
    bindings: [row.approver_session_id, row.account_id, now, now, row.id, row.account_id, now, capabilityHash, completionHash, row.approver_session_id, row.approver_device_id],
  }, [
    db.prepare("UPDATE device_approvals SET state = 'consumed', sealed_payload = NULL, completion_hash = NULL WHERE id = ?").bind(row.id),
    db.prepare('UPDATE customer_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').bind(now, incomingHash),
    db.prepare('INSERT INTO devices (id, account_id, created_at) VALUES (?, ?, ?)').bind(deviceId, row.account_id, now), prepared.statement,
  ])
  return sessionResponse(prepared.session, prepared.token, context)
}
export async function deviceRoute(request: Request, context: ServiceContext): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname
  if (path.startsWith('/api/v1/auth/devices/') && request.method === 'POST') {
    assertOrigin(request, context)
    if (path === '/api/v1/auth/devices/start') return start(request, context)
    if (path === '/api/v1/auth/devices/status') return status(request, context)
    if (path === '/api/v1/auth/devices/complete') return complete(request, context)
    return null
  }
  if (!path.startsWith('/api/v1/account/devices')) return null
  const principal = await requireCustomer(request, context), db = context.env.DB!, now = context.now()
  if (path === '/api/v1/account/devices' && request.method === 'GET') {
    if ([...url.searchParams.keys()].some(key => key !== 'cursor') || url.searchParams.getAll('cursor').length > 1) throw new ApiFailure('INVALID_REQUEST')
    return jsonResponse(await devicePage(principal, context, url.searchParams.get('cursor')))
  }
  if (path === '/api/v1/account/devices/requests' && request.method === 'GET') {
    const rows = await db.prepare("SELECT * FROM device_approvals WHERE account_id = ? AND state = 'pending' AND expires_at > ? ORDER BY expires_at DESC, id DESC LIMIT ?").bind(principal.accountId, now, approvalRequestListLimit + 1).all<ApprovalRow>()
    return jsonResponse({ requests: await Promise.all(rows.results.slice(0, approvalRequestListLimit).map(approvalMetadata)), hasMore: rows.results.length > approvalRequestListLimit })
  }
  const detail = path.match(/^\/api\/v1\/account\/devices\/requests\/([^/]+)$/)
  if (detail && request.method === 'GET') {
    const id = OpaqueIdSchema.safeParse(detail[1]); if (!id.success) throw new ApiFailure('INVALID_REQUEST')
    const row = await db.prepare("SELECT * FROM device_approvals WHERE id = ? AND account_id = ? AND state = 'pending' AND expires_at > ?").bind(id.data, principal.accountId, now).first<ApprovalRow>()
    if (!row) throw new ApiFailure('INVALID_REQUEST')
    return jsonResponse(await approvalMetadata(row))
  }
  if (path === '/api/v1/account/devices/approve' && request.method === 'POST') {
    const input = await readJson(request, DeviceApproveSchema, maxAuthJsonBytes)
    context.checkpoint('auth.devices.approve.before-batch')
    await guarded(context, {
      sql: `SELECT EXISTS (${liveSessionSql} AND a.verified_at IS NOT NULL) AND EXISTS (SELECT 1 FROM device_approvals WHERE id = ? AND account_id = ? AND request_public_key = ? AND state = 'pending' AND expires_at > ?)`,
      bindings: [principal.sessionId, principal.accountId, now, now, input.requestId, principal.accountId, input.requestPublicKey, now],
    }, [db.prepare("UPDATE device_approvals SET state = 'approved', approver_session_id = ?, approver_device_id = ?, sealed_payload = ?, completion_hash = ? WHERE id = ?").bind(principal.sessionId, principal.deviceId, input.sealedPayload, input.completionHash, input.requestId)])
    return jsonResponse({ approved: true })
  }
  if (path === '/api/v1/account/devices/reject' && request.method === 'POST') {
    const input = await readJson(request, DeviceRejectSchema, maxAuthJsonBytes)
    await guarded(context, { sql: `SELECT EXISTS (${liveSessionSql}) AND EXISTS (SELECT 1 FROM device_approvals WHERE id = ? AND account_id = ? AND state IN ('pending', 'approved') AND expires_at > ?)`, bindings: [principal.sessionId, principal.accountId, now, now, input.requestId, principal.accountId, now] }, [
      db.prepare("UPDATE device_approvals SET state = 'rejected', sealed_payload = NULL, completion_hash = NULL WHERE id = ?").bind(input.requestId),
    ])
    return jsonResponse({ rejected: true })
  }
  const removal = path.match(/^\/api\/v1\/account\/devices\/([^/]+)$/)
  if (removal && request.method === 'DELETE') {
    const id = OpaqueIdSchema.safeParse(removal[1]); if (!id.success) throw new ApiFailure('INVALID_REQUEST')
    context.checkpoint('auth.devices.remove.before-batch')
    await guarded(context, { sql: `SELECT EXISTS (${liveSessionSql}) AND EXISTS (SELECT 1 FROM devices WHERE id = ? AND account_id = ?)`, bindings: [principal.sessionId, principal.accountId, now, now, id.data, principal.accountId] }, [
      db.prepare('UPDATE devices SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').bind(now, id.data),
      db.prepare('UPDATE customer_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE device_id = ?').bind(now, id.data),
      // Unapproved requests have no authenticated device identity; only this device's grants are cancelled
      db.prepare("UPDATE device_approvals SET state = 'rejected', sealed_payload = NULL, completion_hash = NULL WHERE approver_device_id = ? AND state = 'approved'").bind(id.data),
    ], 'AUTH_REQUIRED')
    return jsonResponse({ revoked: true })
  }
  return null
}
