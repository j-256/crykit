import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownedLoopbackClient } from './loopback-client.ts'

export const nativeCredentialQuota = Object.freeze({ requests: 60, periodMs: 60_000 })
const rateNoticeTimeoutMs = 5000

export async function expectPrimedSignInRateLimit(page: Page, request: APIRequestContext, origin: string, primingWindow: number, password: string) {
  const evidence = { fixture: 'native-rate-limit-notice', primingWindow, firstUiWindow: 0, firstStatus: 0, reprimedRequests: 0, finalStatus: 0 }
  let noticeDeadline = 0
  const submit = async () => {
    const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/auth/login/start', { timeout: rateNoticeTimeoutMs })
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    noticeDeadline = performance.now() + rateNoticeTimeoutMs
    return response
  }
  try {
    let response = await submit()
    evidence.firstStatus = response.status()
    evidence.firstUiWindow = Math.floor(Date.now() / nativeCredentialQuota.periodMs)
    if (response.status() === 200) {
      // Miniflare's native quota rolls over on wall-clock minute boundaries
      // Accept a fresh window only after measuring that rollover, then exhaust the real binding again
      // An unthrottled request in the original window still fails the quota assertion
      expect(evidence.firstUiWindow).toBe(primingWindow + 1)
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled()
      for (let attempt = 0; attempt < nativeCredentialQuota.requests; attempt++) {
        const primed = await request.post('/api/v1/auth/login/start', { data: {}, headers: { origin } })
        evidence.reprimedRequests++
        if (primed.status() === 429) break
        expect(primed.status()).toBe(400)
      }
      // The form clears passwords before async work; re-enter the synthetic credential for this retry
      await page.getByLabel('Password', { exact: true }).fill(password)
      response = await submit()
    }
    evidence.finalStatus = response.status()
    expect(response.status()).toBe(429)
    return { ...evidence, noticeDeadline }
  } finally { console.info(JSON.stringify(evidence)) }
}

// The listener owns connectivity while the upstream Worker/D1 survive disconnection and restart
// Its exact loopback origin is configured only in the excluded local Worker entry
export async function accountConnectivity(upstream: string, certificate?: string) {
  const send = ownedLoopbackClient(upstream, certificate)
  const upstreamOrigin = new URL(upstream)
  const tls = upstreamOrigin.protocol === 'https:'
  const directory = await mkdtemp(join(tmpdir(), 'crykit-a04-listener-'))
  const config = join(directory, 'openssl.cnf'), key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem')
  if (tls) {
    await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', cert], { stdio: 'ignore' })
  }
  let forwarded = 0
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    try {
      const outgoing = send(request.url ?? '/', { method: request.method, headers: request.headers }, result => {
        response.writeHead(result.statusCode ?? 502, result.headers)
        result.pipe(response)
      })
      forwarded++
      outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
      request.pipe(outgoing)
    } catch { response.writeHead(400); response.end('Invalid owned listener target') }
  }
  const server = tls ? httpsServer({ key: await readFile(key), cert: await readFile(cert) }, handler) : httpServer(handler)
  const configure = (origin: string | null) => new Promise<void>((resolve, reject) => {
    const request = send('/__accounts/control/service-origin', { method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      response.resume(); response.on('end', () => response.statusCode === 200 ? resolve() : reject(new Error('Local origin configuration failed')))
    })
    request.on('error', reject); request.end(JSON.stringify({ origin }))
  })
  let port = 0, listening = false
  const start = async () => {
    if (listening) return
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing owned listener address')
    port = address.port; listening = true
  }
  const stop = async () => {
    if (!listening) return
    listening = false
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  }
  await start()
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${port}`
  const dispose = async () => {
    try { await stop() } finally {
      try { await configure(null) } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }
  try { await configure(origin) } catch (error) { await dispose(); throw error }
  return { origin, start, stop, forwarded: () => forwarded, dispose }
}

// Complete actual synthetic precache preparation within the caller's unchanged overall case budget
// The subsequent readiness assertion still owns its original deadline
export async function prepareAccountProofCache(page: Page): Promise<void> {
  const durationMs = await page.evaluate(async () => {
    const started = performance.now()
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
    return performance.now() - started
  })
  console.info(JSON.stringify({ fixture: 'account-cache-preparation', durationMs }))
}
