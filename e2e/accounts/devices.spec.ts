import { expect, test } from '@playwright/test'
import type * as Auth from '../../src/account/auth-client'
import type * as Devices from '../../src/account/device-approval'
import type { UnlockResult } from '../../src/account/auth-client'
import type { PendingDeviceApproval } from '../../src/account/device-approval'

type ProofWindow = Window & { accountAuth: typeof Auth; accountDevices: typeof Devices; unlocked: UnlockResult; pending: PendingDeviceApproval }

test('twoBrowsersCompareFingerprintTransferKeyRejectReplayAndRevokeAccess', async ({ page, browser, baseURL }, testInfo) => {
  const username = `pair_${Date.now().toString(36)}`, password = 'synthetic pairing browser password'
  const email = `${username}@example.org`
  await page.goto('/__accounts-proof/')
  await expect(page.locator('#status')).toHaveText('Browser worker and offline cache ready')
  await page.evaluate(input => (window as unknown as ProofWindow).accountAuth.registerAccount(input), { email, username, password, remember: false })
  await page.request.post('/__accounts/jobs')
  const emails = await (await page.request.get('/__accounts/emails')).json() as { recipient: string; capability: string }[]
  await page.evaluate(capability => fetch('/api/v1/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ capability }) }), emails.find(message => message.recipient === email)!.capability)
  const originalKey = await page.evaluate(async input => {
    const w = window as unknown as ProofWindow; w.unlocked = await w.accountAuth.loginAccount(input)
    return Array.from(w.unlocked.key)
  }, { email, password, remember: false })
  const requester = await browser.newContext({ ignoreHTTPSErrors: baseURL?.startsWith('https:') })
  try {
    const other = await requester.newPage()
    await other.goto(`${baseURL}/__accounts-proof/`)
    await expect(other.locator('#status')).toHaveText('Browser worker and offline cache ready')
    let completionBody = ''
    other.on('request', request => { if (request.url().endsWith('/devices/complete')) completionBody = request.postData()! })
    const pending = await other.evaluate(async email => {
      const w = window as unknown as ProofWindow; w.pending = await w.accountDevices.beginDeviceApproval(email)
      const output = document.createElement('output'); output.id = 'comparison'; output.textContent = w.pending.fingerprint; document.body.append(output)
      return { requestId: w.pending.requestId, fingerprint: w.pending.fingerprint }
    }, email)
    const comparison = await page.evaluate(async requestId => {
      const w = window as unknown as ProofWindow, page = await w.accountDevices.listApprovalRequests(w.unlocked)
      const request = page.requests.find(request => request.requestId === requestId)!
      const output = document.createElement('output'); output.id = 'comparison'; output.textContent = request.fingerprint; document.body.append(output)
      try { await w.accountDevices.approveDevice(w.unlocked, request, '0000 0000 0000 0000'); return { rejectedMismatch: false, fingerprint: request.fingerprint } } catch { return { rejectedMismatch: true, fingerprint: request.fingerprint } }
    }, pending.requestId)
    expect(comparison).toEqual({ fingerprint: pending.fingerprint, rejectedMismatch: true })
    await expect(page.locator('#comparison')).toHaveText(pending.fingerprint)
    await expect(other.locator('#comparison')).toHaveText(pending.fingerprint)
    expect(pending.fingerprint).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){3}$/)
    await page.evaluate(async pending => {
      const w = window as unknown as ProofWindow, request = await w.accountDevices.getApprovalRequest(w.unlocked, pending.requestId)
      await w.accountDevices.approveDevice(w.unlocked, request, pending.fingerprint)
    }, pending)
    const completed = await other.evaluate(async () => {
      const w = window as unknown as ProofWindow; w.unlocked = await w.accountDevices.completeDeviceApproval(w.pending, false)
      return { key: Array.from(w.unlocked.key), deviceId: w.unlocked.deviceId, cleared: w.pending.privateKey.every(byte => byte === 0) && w.pending.requestCapability === '' }
    })
    expect(completed.key).toEqual(originalKey)
    expect(completed.cleared).toBe(true)
    expect((await requester.cookies())[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', expires: -1 })
    expect(await other.evaluate(() => document.cookie)).not.toContain('__Host-crykit-session')
    expect(await other.evaluate(body => fetch('/api/v1/auth/devices/complete', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(response => response.status), completionBody)).toBe(400)
    await page.evaluate(async deviceId => { const w = window as unknown as ProofWindow; await w.accountDevices.removeDevice(w.unlocked, deviceId) }, completed.deviceId)
    expect(await other.evaluate(() => fetch('/api/v1/account').then(response => response.status))).toBe(401)
    expect(await page.evaluate(() => fetch('/api/v1/account').then(response => response.status))).toBe(200)
    await testInfo.attach('device-approval-evidence', { body: JSON.stringify({ comparedFingerprint: true, mismatchRejected: true, sameAccountKey: true, completionReplayStatus: 400, removedDeviceReadStatus: 401, requesterSecretsCleared: true }), contentType: 'application/json' })
  } finally { await requester.close() }
})
