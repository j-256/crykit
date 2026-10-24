import { test as base, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

const RUNTIME_START_TIMEOUT_MS = 120_000
const MAX_DIAGNOSTIC_CHARACTERS = 64 * 1024
type AccountRuntime = { origin: string; certificate?: string }

export async function startAccountRuntime() {
  const child = spawn(process.execPath, ['scripts/serve-account-acceptance.mjs'], {
    env: { ...process.env, CRYKIT_ACCOUNTS_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  if (!child.stdout || !child.stderr) throw new Error('Missing account runtime output pipes')
  const exited = once(child, 'close')
  const lines = createInterface({ input: child.stdout })
  let diagnostics = ''
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-MAX_DIAGNOSTIC_CHARACTERS) })
  let resolveReady!: (runtime: AccountRuntime) => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<AccountRuntime>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  child.on('error', rejectReady)
  lines.on('line', line => {
    try {
      const value = JSON.parse(line)
      if (value.event === 'ready' && /^https:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(value.origin) && typeof value.certificate === 'string') resolveReady({ origin: value.origin, certificate: value.certificate })
    } catch { /* Only the documented ready record is a result */ }
  })
  void exited.then(([code, signal]) => rejectReady(new Error(`Account runtime exited (${code ?? signal}): ${diagnostics}`)), rejectReady)
  const timer = setTimeout(() => rejectReady(new Error(`Account runtime did not become ready: ${diagnostics}`)), RUNTIME_START_TIMEOUT_MS)
  const dispose = async () => {
    // Miniflare's process signal hook exits immediately with 143 before async disposal finishes
    // An owned IPC message lets the adapter await Worker cleanup and report its actual result
    if (child.connected) child.send({ type: 'crykit-account-stop' })
    const [code, signal] = await exited
    lines.close()
    if (code !== 0) throw new Error(`Account runtime shutdown failed (${code ?? signal}): ${diagnostics}`)
  }
  try { return { ...await ready, dispose } }
  catch (error) { await dispose(); throw error }
  finally { clearTimeout(timer) }
}

export const test = base.extend<{}, { accountRuntime: AccountRuntime; accountOrigin: string }>({
  // A Worker/D1/R2 lifetime belongs to one test worker, including its serial beforeAll contexts
  // Independent workers must never share origin overrides, gates, faults or rate counters
  accountRuntime: [async ({}, use, workerInfo) => {
    if (process.env.CRYKIT_OWN_ACCOUNT_RUNTIME !== '1') {
      const origin = workerInfo.project.use.baseURL
      if (!origin) throw new Error('Missing account test origin')
      await use({ origin })
      return
    }
    const runtime = await startAccountRuntime()
    try { await use(runtime) } finally { await runtime.dispose() }
  }, { scope: 'worker', timeout: RUNTIME_START_TIMEOUT_MS }],
  accountOrigin: [async ({ accountRuntime }, use) => { await use(accountRuntime.origin) }, { scope: 'worker' }],
  baseURL: async ({ accountOrigin }, use) => { await use(accountOrigin) },
})

export { expect }

export type { Page, BrowserContext, TestInfo } from '@playwright/test'
