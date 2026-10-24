import { z } from 'zod'
import { CredentialIdSchema, OpaqueFieldSchemas, maxAuthJsonBytes } from '../../src/account/protocol'
import { finishServerLogin, registrationResponse, startServerLogin } from '../auth/opaque'
import type { ServiceEnv } from '../context'
import { ApiFailure, jsonResponse, readJson } from '../http'

const ProbeSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('registration'), credentialId: CredentialIdSchema, request: OpaqueFieldSchemas.registrationRequest }),
  z.strictObject({ operation: z.literal('login'), credentialId: CredentialIdSchema, record: OpaqueFieldSchemas.registrationRecord.nullable(), request: OpaqueFieldSchemas.startLoginRequest }),
  z.strictObject({ operation: z.literal('finish'), state: OpaqueFieldSchemas.serverLoginState, request: OpaqueFieldSchemas.finishLoginRequest }),
])
// This entry is imported only by the loopback fixture, never the customer production entry
export async function opaqueProbe(request: Request, env: ServiceEnv): Promise<Response> {
  if (!env.OPAQUE_SERVER_SETUP) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const input = await readJson(request, ProbeSchema, maxAuthJsonBytes)
  if (input.operation === 'registration') return jsonResponse({ response: await registrationResponse(env.OPAQUE_SERVER_SETUP, input.credentialId, input.request) })
  if (input.operation === 'login') return jsonResponse(await startServerLogin(env.OPAQUE_SERVER_SETUP, input.credentialId, input.record, input.request))
  await finishServerLogin(input.state, input.request)
  return jsonResponse({ ok: true })
}
// Synthetic ciphertext storage proves the HTTP/D1/R2 seam without granting customer access
export async function storeOpaqueProof(request: Request, env: ServiceEnv): Promise<Response> {
  if (!env.DB || !env.OBJECTS) throw new ApiFailure('SERVICE_UNAVAILABLE')
  await env.DB.exec('CREATE TABLE IF NOT EXISTS opaque_proof (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)')
  if (request.method === 'POST') {
    const input = await readJson(request, z.strictObject({ record: OpaqueFieldSchemas.registrationRecord, payload: z.string().min(1).max(32000), ciphertext: z.string().min(1).max(16000) }), maxAuthJsonBytes)
    await env.DB.prepare('INSERT OR REPLACE INTO opaque_proof (id,payload) VALUES (1,?)').bind(JSON.stringify({ record: input.record, payload: input.payload })).run()
    await env.OBJECTS.put('opaque-proof-ciphertext', input.ciphertext)
    return jsonResponse({ ok: true })
  }
  const row = await env.DB.prepare('SELECT payload FROM opaque_proof WHERE id=1').first<string>('payload')
  return jsonResponse({ database: row ? JSON.parse(row) as unknown : null, object: await (await env.OBJECTS.get('opaque-proof-ciphertext'))?.text() ?? null })
}
