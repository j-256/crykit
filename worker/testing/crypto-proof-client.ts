import * as accountLifecycle from '../../src/account/lifecycle'
import * as accountProfile from '../../src/account/profile'
import * as accountDeviceStore from '../../src/account/device-store'
import * as accountDevices from '../../src/account/device-approval'
import { registerAccount, loginAccount, changePassword, replaceRecoveryCode, loginWithRecovery } from '../../src/account/auth-client'
import { probeJson } from './probe-client'
import { z } from 'zod'
import type { KeyEnvelope, RevisionDescriptor } from '../../src/account/protocol'

const credentialId = 'crykit/password/AAAAAAAAAAAAAAAAAAAAAA'
interface LoginInput { password: string; state: string; response: string; serverState: string; payload: Registration['payload']; ciphertext: number[][] }
interface Stored { record: string; payload: string }
interface Registration { record: string; payload: { envelope: KeyEnvelope; descriptor: RevisionDescriptor }; ciphertext: number[][]; key: number[]; accountKeyEncoded: string; exportKeyEncoded: string; recoverySecret: string }
const measurements: { operation: string; wallMs: number }[] = []
let worker: Worker
let sequence = 0
const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; operation: string }>()
function resetWorker() {
  worker?.terminate()
  worker = new Worker(new URL('./crypto-proof-worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = event => {
    const pending = waiting.get(event.data.id)
    if (!pending) return
    waiting.delete(event.data.id)
    measurements.push({ operation: pending.operation, wallMs: event.data.wallMs })
    if (event.data.error) pending.reject(new Error(event.data.error))
    else pending.resolve(event.data.result)
  }
}
resetWorker()
function rpc<T>(operation: string, data: object): Promise<T> {
  const id = ++sequence
  return new Promise((resolve, reject) => { waiting.set(id, { resolve: value => resolve(value as T), reject, operation }); worker.postMessage({ id, operation, ...data }) })
}
const post = <T>(path: string, schema: z.ZodType<T>, data: object) => probeJson(location.origin, path, schema, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
const startSchema = z.strictObject({ state: z.string(), response: z.string() })
const storageSchema = z.strictObject({ database: z.strictObject({ record: z.string(), payload: z.string() }).nullable(), object: z.string().nullable() })
const proof = {
  measurements,
  policy: (password: string) => rpc('policy', { password }),
  async register(password: string) {
    const start = await rpc<{ state: string; request: string }>('start-registration', { password })
    const response = await post('/__accounts/probe/opaque', z.strictObject({ response: z.string() }), { operation: 'registration', credentialId, request: start.request })
    const result = await rpc<Registration>('finish-registration', { password, state: start.state, response: response.response })
    await post('/__accounts/probe/opaque-storage', z.strictObject({ ok: z.boolean() }), { record: result.record, payload: JSON.stringify(result.payload), ciphertext: JSON.stringify(result.ciphertext) })
    return result
  },
  async prepareLogin(password: string, unknown = false): Promise<LoginInput> {
    const stored = await probeJson(location.origin, '/__accounts/probe/opaque-storage', storageSchema)
    if (!stored.database || !stored.object) throw new Error('MISSING_FIXTURE')
    const start = await rpc<{ state: string; request: string }>('start-login', { password })
    const server = await post('/__accounts/probe/opaque', startSchema, { operation: 'login', credentialId, record: unknown ? null : stored.database.record, request: start.request })
    return { password, state: start.state, response: server.response, serverState: server.state, payload: JSON.parse((stored.database as Stored).payload) as Registration['payload'], ciphertext: JSON.parse(stored.object) as number[][] }
  },
  async completeLogin(input: LoginInput) {
    return rpc<{ key: number[]; request: string }>('finish-login', input)
  },
  async login(password: string) {
    const input = await this.prepareLogin(password)
    const result = await this.completeLogin(input)
    await post('/__accounts/probe/opaque', z.strictObject({ ok: z.boolean() }), { operation: 'finish', state: input.serverState, request: result.request })
    return result.key
  },
  resetWorker,
}
Object.assign(window, { accountLifecycle, accountProfile, accountDeviceStore, proof, accountDevices, accountAuth: { registerAccount, loginAccount, changePassword, replaceRecoveryCode, loginWithRecovery } })
await navigator.serviceWorker.register('./sw.js')
await navigator.serviceWorker.ready
if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
document.querySelector('#status')!.textContent = 'Browser worker and offline cache ready'
