import { ready, server } from '@serenity-kit/opaque'
import { CredentialIdSchema, OpaqueFieldSchemas, opaqueServerIdentity } from '../../src/account/protocol'
import { ApiFailure } from '../http'

// Setup is provisioned/restored as a secret; regenerating it invalidates every existing credential
export async function registrationResponse(setup: string, credentialId: string, request: string): Promise<string> {
  const params = { serverSetup: OpaqueFieldSchemas.setup.parse(setup), userIdentifier: CredentialIdSchema.parse(credentialId), registrationRequest: OpaqueFieldSchemas.registrationRequest.parse(request) }
  await ready
  return OpaqueFieldSchemas.registrationResponse.parse(server.createRegistrationResponse(params).registrationResponse)
}
export async function startServerLogin(setup: string, credentialId: string, record: string | null, request: string): Promise<{ state: string; response: string }> {
  const params = { serverSetup: OpaqueFieldSchemas.setup.parse(setup), userIdentifier: CredentialIdSchema.parse(credentialId), registrationRecord: record === null ? null : OpaqueFieldSchemas.registrationRecord.parse(record), startLoginRequest: OpaqueFieldSchemas.startLoginRequest.parse(request), identifiers: { client: credentialId, server: opaqueServerIdentity } }
  await ready
  // Null delegates unknown accounts to opaque-ke's dummy record, using the same fixed transcript shape
  const result = server.startLogin(params)
  return { state: OpaqueFieldSchemas.serverLoginState.parse(result.serverLoginState), response: OpaqueFieldSchemas.loginResponse.parse(result.loginResponse) }
}
export async function finishServerLogin(state: string, request: string): Promise<void> {
  const params = { serverLoginState: OpaqueFieldSchemas.serverLoginState.parse(state), finishLoginRequest: OpaqueFieldSchemas.finishLoginRequest.parse(request) }
  await ready
  try { server.finishLogin(params) } catch { throw new ApiFailure('AUTH_FAILED') }
  // Routes must consume expiring attempt state atomically; this adapter only verifies and discards the session key
}
