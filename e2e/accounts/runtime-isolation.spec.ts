import { test, expect, startAccountRuntime } from './test-fixture'
import { prepareAccountProofCache } from './network-fixture'

test('ownedBackendsKeepOriginsGatesFaultsCountersAndAccountDataIndependent', async ({ browser, page, request, accountOrigin }) => {
  // Worker backends retain prior journeys, so the other runtime must leave this exact capture unchanged
  const capturedBefore = await (await request.get('/__accounts/emails')).json()
  const second = await startAccountRuntime()
  const other = await browser.newContext({ baseURL: second.origin, ignoreHTTPSErrors: true })
  try {
    expect(second.origin).not.toBe(accountOrigin)
    const count = async (origin: string) => (await (await request.get(`${origin}/__accounts/measurement`)).json()).workerRequests
    const before = await count(second.origin)
    await request.post('/__accounts/control/service-origin', { data: { origin: 'https://127.0.0.1:1' } })
    const post = (origin: string) => request.post(`${origin}/api/v1/auth/logout`, { headers: { origin }, data: {} })
    expect((await post(accountOrigin)).status()).toBe(403)
    expect(await count(second.origin)).toBe(before)
    expect((await post(second.origin)).status()).not.toBe(403)
    expect((await request.post('/__accounts/control/service-origin', { data: { origin: null } })).ok()).toBe(true)

    await request.post('/__accounts/control/response-gate', { data: { path: '/api/v1/auth/logout', phase: 'before-headers' } })
    const held = post(accountOrigin)
    try {
      await expect.poll(async () => (await (await request.get('/__accounts/control/response-gate')).json()).arrived).toBe(true)
      expect((await (await request.get(`${second.origin}/__accounts/control/response-gate`)).json()).arrived).toBe(false)
      expect((await post(second.origin)).status()).not.toBe(403)
    } finally { await request.post('/__accounts/control/release-response'); await held }

    expect((await request.post('/__accounts/control/faults', { data: ['auth.signup.before-batch'] })).ok()).toBe(true)
    const otherPage = await other.newPage()
    const username = `isolation_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`
    const input = { username, email: `${username}@example.org`, password: 'synthetic isolation password', remember: false }
    for (const target of [page, otherPage]) {
      await target.goto('/__accounts-proof/')
      await prepareAccountProofCache(target)
      await expect(target.locator('#status')).toHaveText('Browser worker and offline cache ready')
    }
    const register = (target: typeof page) => target.evaluate(async input => {
      try {
        await (window as unknown as { accountAuth: typeof import('../../src/account/auth-client') }).accountAuth.registerAccount(input)
        return 'pending'
      } catch (error) { return (error as Error).message }
    }, input)
    expect(await register(page)).toBe('SERVICE_UNAVAILABLE')
    expect(await register(otherPage)).toBe('pending')
    await otherPage.request.post('/__accounts/jobs')
    expect(await (await request.get('/__accounts/emails')).json()).toEqual(capturedBefore)
    expect(await (await otherPage.request.get('/__accounts/emails')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ recipient: input.email })]))
  } finally { await other.close(); await second.dispose() }
})
