import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { maxAuthJsonBytes } from '../../src/account/protocol'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { availableParallelism, cpus, totalmem } from 'node:os'
import { ownedLoopbackClient } from './loopback-client'

type LoginInput = { password: string; state: string; response: string; serverState: string; payload: unknown; ciphertext: number[][] }
interface Proof {
  register(password: string): Promise<{ key: number[]; accountKeyEncoded: string; exportKeyEncoded: string; recoverySecret: string }>
  login(password: string): Promise<number[]>
  prepareLogin(password: string, unknown?: boolean): Promise<LoginInput>
  completeLogin(input: LoginInput): Promise<{ key: number[]; request: string }>
  policy(password: string): Promise<{ valid: boolean; reason?: string }>
  resetWorker(): void
  measurements: { operation: string; wallMs: number }[]
}
async function ready(page: Page, baseURL: string) {
  await page.goto(`${baseURL}/__accounts-proof/`)
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
}
// OS cumulative CPU time and RSS are observations, not Worker billing or a peak-allocation bound
function processObservation() {
  const lines = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm='], { encoding: 'utf8' }).trim().split('\n')
  const rows = lines.map(line => { const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)!; return { pid: Number(match[1]), parent: Number(match[2]), rssKiB: Number(match[3]), cpuTime: match[4], executable: match[5] } })
  const descendants = new Set([process.ppid])
  for (let pass = 0; pass < rows.length; pass++) for (const row of rows) if (descendants.has(row.parent)) descendants.add(row.pid)
  return rows.filter(row => descendants.has(row.pid) && /Chromium|chrome|firefox|WebKit|MiniBrowser/i.test(row.executable))
}

// Closing this test-owned proxy proves network absence without WebKit's offline-emulation failure
async function localProxy(baseURL: string) {
  const send = ownedLoopbackClient(baseURL)
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) { size += chunk.length; if (size > maxAuthJsonBytes) throw new Error('Oversize local probe'); chunks.push(chunk) }
      const outgoing = send(request.url ?? '/', { method: request.method, headers: request.headers['content-type'] ? { 'content-type': request.headers['content-type'] } : {} }, result => {
        // Native streams preserve encoded bytes and matching headers without fetch's automatic decoding
        response.writeHead(result.statusCode ?? 502, result.headers)
        result.pipe(response)
      })
      outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end('Local proxy unavailable') })
      outgoing.end(chunks.length ? Buffer.concat(chunks) : undefined)
    } catch { response.writeHead(502); response.end('Local proxy unavailable') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local proxy address')
  let stopped = false
  return { origin: `http://127.0.0.1:${address.port}`, async stop() {
    if (stopped) return
    stopped = true
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  } }
}

test('recoversSameAccountKeyInIndependentBrowserContexts', async ({ browser, baseURL }, testInfo) => {
  const proxy = await localProxy(baseURL!)
  const first = await browser.newContext()
  const second = await browser.newContext()
  const httpBodies: string[] = []
  const password = ' e\u0301 synthetic password with spaces '
  const before = processObservation()
  const started = performance.now()
  try {
    const page = await first.newPage()
    page.on('request', request => { if (request.url().includes('/__accounts/probe/')) httpBodies.push(request.postData() ?? '') })
    await ready(page, proxy.origin)
    const registered = await page.evaluate(async password => (window as unknown as { proof: Proof }).proof.register(password), password)
    const other = await second.newPage()
    other.on('request', request => { if (request.url().includes('/__accounts/probe/')) httpBodies.push(request.postData() ?? '') })
    await ready(other, proxy.origin)
    const secondBrowserKey = await other.evaluate(async password => (window as unknown as { proof: Proof }).proof.login(password), password)
    const firstBrowserKey = registered.key
    expect(secondBrowserKey).toEqual(firstBrowserKey)
    const dump = await other.request.get(`${proxy.origin}/__accounts/probe/opaque-storage`)
    const serverDump = JSON.stringify({ http: httpBodies, storage: await dump.json() })
    expect(serverDump).not.toContain(password)
    expect(serverDump).not.toContain(registered.recoverySecret)
    expect(serverDump).not.toContain(registered.exportKeyEncoded)
    expect(serverDump).not.toContain('synthetic private revision')
    expect(serverDump).not.toContain(JSON.stringify(firstBrowserKey))
    expect(serverDump).not.toContain(registered.accountKeyEncoded)
    // A prepared transcript lets a fresh Worker initialize and derive/decrypt entirely offline
    const offlineInput = await other.evaluate(async password => (window as unknown as { proof: Proof }).proof.prepareLogin(password), password)
    const secondOnline = await other.evaluate(() => (window as unknown as { proof: Proof }).proof.measurements)
    await proxy.stop()
    expect(await other.evaluate(async () => fetch('/__accounts/probe/opaque-storage', { cache: 'no-store' }).then(() => false, () => true))).toBe(true)
    await other.reload()
    await expect(other.locator('#status')).toHaveText('Browser worker and offline cache ready')
    const offlineResult = await other.evaluate(async input => (window as unknown as { proof: Proof }).proof.completeLogin(input), offlineInput)
    expect(offlineResult.key).toEqual(firstBrowserKey)
    const observations = JSON.stringify({ browser: testInfo.project.name, version: browser.version(), offlineMechanism: 'test-owned loopback listener closed; uncached request failed; cached reload and new Worker succeeded', cpu: cpus()[0]?.model, availableLogicalCPUs: availableParallelism(), hostMemoryBytes: totalmem(), wallMs: performance.now() - started, processesBefore: before, processesAfter: processObservation(), secondOnline, online: await page.evaluate(() => (window as unknown as { proof: Proof }).proof.measurements), offline: await other.evaluate(() => (window as unknown as { proof: Proof }).proof.measurements) }, null, 2)
    const artifact = testInfo.outputPath('runtime-measurements.json')
    await writeFile(artifact, observations)
    await testInfo.attach('runtime-measurements.json', { path: artifact, contentType: 'application/json' })
  } finally { await first.close(); await second.close(); await proxy.stop() }
})

test('password bytes and Unicode survive browser Worker boundaries', async ({ page, baseURL }) => {
  await ready(page, baseURL!)
  const policies = await page.evaluate(async () => {
    const p = (window as unknown as { proof: Proof }).proof
    return Promise.all(['é'.repeat(512), 'é'.repeat(512) + 'a', '😀'.repeat(14), '\ud800' + 'a'.repeat(15)].map(password => p.policy(password)))
  })
  expect(policies).toEqual([{ valid: true }, { valid: false, reason: 'too-long' }, { valid: false, reason: 'too-short' }, { valid: false, reason: 'invalid-unicode' }])
  // This is the exact pasted UTF-8 boundary, not just a policy-only validation
  const keys = await page.evaluate(async () => {
    const p = (window as unknown as { proof: Proof }).proof
    const password = 'é'.repeat(512)
    const registered = await p.register(password)
    return { first: registered.key, second: await p.login(password) }
  })
  expect(keys.second).toEqual(keys.first)
})

test('dummyAndWrongPasswordHaveSamePublicFailure', async ({ page, baseURL }) => {
  await ready(page, baseURL!)
  const failures = await page.evaluate(async () => {
    const p = (window as unknown as { proof: Proof }).proof
    const password = ' e\u0301 synthetic password with spaces '
    await p.register(password)
    const results: string[] = []
    // NFC and trimming would silently change the registered password
    for (const [value, unknown] of [[password.normalize('NFC'), false], [password.trim(), false], [password, true]] as const) {
      const input = await p.prepareLogin(value, unknown)
      try { await p.completeLogin(input); results.push('UNEXPECTED_SUCCESS') } catch (error) { results.push((error as Error).message) }
    }
    return results
  })
  const [wrongPasswordResponse, trimmedPasswordResponse, unknownAccountResponse] = failures
  expect(wrongPasswordResponse).toEqual('AUTH_FAILED')
  expect(trimmedPasswordResponse).toEqual('AUTH_FAILED')
  expect(wrongPasswordResponse).toEqual(unknownAccountResponse)
})
