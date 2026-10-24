import { CredentialIdSchema, OpaqueFieldSchemas, opaqueServerIdentity } from '../protocol'
import { validatePassword } from '../password-policy'
export { opaqueServerIdentity } from '../protocol'

// The password runtime initializes Wasm on import; guest entry must never evaluate it
// Units are KiB in the pinned Rust Argon2 ParamsBuilder; never use the library default
export const opaqueKeyStretching = Object.freeze({ 'argon2id-custom': Object.freeze({ memory: 65536, iterations: 2, parallelism: 1 }) })
function passwordInput(password: string) {
  if (!validatePassword(password).valid) throw new Error('INVALID_PASSWORD')
  return password
}
function identifiers(credentialId: string) { return { client: CredentialIdSchema.parse(credentialId), server: opaqueServerIdentity } }
function exportBytes(value: string) {
  const encoded = OpaqueFieldSchemas.exportKey.parse(value)
  return Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0))
}
export async function startRegistration(password: string): Promise<{ state: string; request: string }> {
  passwordInput(password)
  const { client, ready } = await import('@serenity-kit/opaque')
  await ready
  const result = client.startRegistration({ password })
  return { state: OpaqueFieldSchemas.clientRegistrationState.parse(result.clientRegistrationState), request: OpaqueFieldSchemas.registrationRequest.parse(result.registrationRequest) }
}
export async function finishRegistration(state: string, response: string, password: string, credentialId: string): Promise<{ record: string; exportKey: Uint8Array }> {
  const params = { clientRegistrationState: OpaqueFieldSchemas.clientRegistrationState.parse(state), registrationResponse: OpaqueFieldSchemas.registrationResponse.parse(response), password: passwordInput(password), identifiers: identifiers(credentialId), keyStretching: opaqueKeyStretching }
  const { client, ready } = await import('@serenity-kit/opaque')
  await ready
  const result = client.finishRegistration(params)
  return { record: OpaqueFieldSchemas.registrationRecord.parse(result.registrationRecord), exportKey: exportBytes(result.exportKey) }
}
export async function startLogin(password: string): Promise<{ state: string; request: string }> {
  passwordInput(password)
  const { client, ready } = await import('@serenity-kit/opaque')
  await ready
  const result = client.startLogin({ password })
  return { state: OpaqueFieldSchemas.clientLoginState.parse(result.clientLoginState), request: OpaqueFieldSchemas.startLoginRequest.parse(result.startLoginRequest) }
}
export async function finishLogin(state: string, response: string, password: string, credentialId: string): Promise<{ request: string; exportKey: Uint8Array }> {
  const params = { clientLoginState: OpaqueFieldSchemas.clientLoginState.parse(state), loginResponse: OpaqueFieldSchemas.loginResponse.parse(response), password: passwordInput(password), identifiers: identifiers(credentialId), keyStretching: opaqueKeyStretching }
  const { client, ready } = await import('@serenity-kit/opaque')
  await ready
  const result = client.finishLogin(params)
  if (!result) throw new Error('AUTH_FAILED')
  // The server knows sessionKey; omit it at this boundary so callers can only wrap with exportKey
  return { request: OpaqueFieldSchemas.finishLoginRequest.parse(result.finishLoginRequest), exportKey: exportBytes(result.exportKey) }
}
