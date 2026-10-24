import { createServer, type Server } from 'node:https'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, test } from '@playwright/test'
import { createServiceFixture, type ServiceFixture } from '../../worker/testing/service-fixture'
import { createAccessIssuer } from '../../worker/testing/access-issuer'

test.use({ ignoreHTTPSErrors: true })

const id = () => randomBytes(16).toString('base64url')
const keyedHash = async (secret: string, purpose: string, value: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', Buffer.from(secret, 'base64url'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify([1, purpose, value])))).toString('base64url')
}
const snapshot = { version: 5, kind: 'build', title: 'Intentional public snapshot', setup: { catalogLock: {}, baseline: null, layers: [], mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [] }, slots: [{ primaryClass: null, secondaryClass: null, equipment: [], equipmentGroups: [], passives: [] }], receipts: [] }
test('adminPanelUsesRealSignedServiceAndKeepsCustomerAndPublicGuards', async ({ page, browser }) => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-c04-browser-'))
  let service: ServiceFixture | undefined
  let server: Server | undefined
  try {
    const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem'), config = join(directory, 'openssl.cnf')
    await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n')
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', cert], { stdio: 'ignore' })
    const issuer = createAccessIssuer(), now = Date.now()
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      if (!service) { response.writeHead(503).end(); return }
      try {
        const path = request.url ?? '/'
        const headers = new Headers()
        for (const name of ['cookie', 'origin', 'content-type', 'x-csrf-token', 'accept']) {
          const value = request.headers[name]
          if (typeof value === 'string') headers.set(name, value)
        }
        const invitee = request.headers['x-test-principal'] === 'invitee'
        const claims = invitee ? { sub: 'synthetic-invitee', email: 'invitee@example.org' } : {}
        headers.set('cf-access-jwt-assertion', path.startsWith('/admin/confirm/') ? issuer.token(now, { ...claims, aud: ['action-confirmation'], exp: Math.floor(now / 1000) + 900 }) : issuer.token(now, claims))
        const parts: Buffer[] = []
        for await (const part of request) parts.push(Buffer.from(part))
        const result = await service.request(path, { method: request.method, headers, ...(parts.length ? { body: Buffer.concat(parts) } : {}) })
        response.writeHead(result.status, Object.fromEntries(result.headers))
        response.end(Buffer.from(await result.arrayBuffer()))
      } catch {
        // A closing browser can abort a streamed body after its headers reached the client
        if (response.headersSent) response.destroy()
        else if (!response.destroyed) response.writeHead(503).end()
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Synthetic server address unavailable')
    const base = `https://127.0.0.1:${address.port}`
    service = await createServiceFixture({ production: true, serviceOrigin: base, now, assets: { directory: 'dist', run_worker_first: ['/api/*', '/admin', '/admin/*'] }, adminConfig: JSON.stringify({ version: 1, issuer: issuer.issuer, jwksUrl: `${issuer.issuer}/cdn-cgi/access/certs`, adminAudience: 'ordinary-admin', confirmationAudience: 'action-confirmation', confirmationEnabled: true }), accessKeys: async () => Response.json(issuer.jwks) })
    const accountId = id(), operatorId = id(), shareId = id(), deviceId = id(), sessionId = id(), token = randomBytes(32).toString('base64url')
    await service.db.prepare("INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,?,'synthetic-owner','owner@example.org','owner','active',1,?)").bind(operatorId, issuer.issuer, now).run()
    await service.db.prepare("INSERT INTO accounts(id,normalized_email,delivery_email,username,verified_at,capacity_bytes,created_at) VALUES (?,'customer@example.org','customer@example.org','synthetic',?,1000000,?)").bind(accountId, now, now).run()
    for (let index = 0; index < 51; index++) {
      const older = now - (index + 1) * 1000
      await service.db.prepare('INSERT INTO accounts(id,normalized_email,delivery_email,username,verified_at,capacity_bytes,created_at) VALUES (?,?,?,?,?,1000000,?)').bind(id(), `older${index}@example.org`, `older${index}@example.org`, `older-${index}`, older, older).run()
    }
    await service.db.prepare('INSERT INTO devices(id,account_id,created_at) VALUES (?,?,?)').bind(deviceId, accountId, now).run()
    await service.db.prepare('INSERT INTO customer_sessions(id,token_hash,account_id,device_id,authenticated_at,idle_expires_at,absolute_expires_at,remembered) VALUES (?,?,?,?,?,?,?,0)').bind(sessionId, await keyedHash(service.env.SESSION_SECRET, 'customer-session', token), accountId, deviceId, now, now + 3_600_000, now + 3_600_000).run()
    await service.db.prepare("INSERT INTO shares(id,account_id,revision,snapshot_revision,state,include_attribution,created_at,updated_at) VALUES (?,?,1,1,'active',0,?,?)").bind(shareId, accountId, now, now).run()
    await service.db.prepare('INSERT INTO share_snapshots(share_id,account_id,revision,snapshot) VALUES (?,?,1,?)').bind(shareId, accountId, JSON.stringify(snapshot)).run()
    const emailJobId = id(), serviceJobId = id()
    await service.db.prepare("INSERT INTO email_jobs(id,request_digest,request_id,state,delivery,next_attempt_at,expires_at,created_at,updated_at) VALUES (?,'synthetic-email','synthetic-email','queued','pending',?,?,?,?)").bind(emailJobId, now + 60_000, now + 3_600_000, now, now).run()
    await service.db.prepare("INSERT INTO service_jobs(id,type,phase,account_id,expected_revision,next_at,request_id,created_at) VALUES (?,'cleanup','review',?,1,?,'synthetic-service',?)").bind(serviceJobId, accountId, now + 60_000, now).run()
    const publicBefore = await page.request.get(`${base}/api/public/v1/shares/${shareId}`)
    expect(publicBefore.status()).toBe(200)
    await page.goto(`${base}/admin/`)
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Storage composition' })).toBeVisible()
    await expect(page.getByRole('img', { name: /Share of accounted storage/ })).toBeVisible()
    await expect(page.getByRole('img', { name: 'queued: 1 jobs' })).toBeVisible()
    await expect(page.getByRole('link', { name: `Inspect job ${serviceJobId}` })).toBeVisible()
    await page.getByRole('link', { name: `Inspect job ${serviceJobId}` }).first().click()
    await expect(page).toHaveURL(new RegExp(`#jobs\\?jobId=${serviceJobId}$`))
    await expect(page.getByRole('region', { name: 'Job detail' })).toContainText(serviceJobId)
    await page.getByRole('link', { name: 'Accounts' }).click()
    await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Value' }).fill('absent@example.org')
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.getByRole('button', { name: `Inspect account ${accountId}` })).toHaveCount(0)
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await page.getByRole('button', { name: 'Next page' }).click()
    await expect(page.getByText('Page 2')).toBeVisible()
    await expect(page.getByRole('button', { name: `Inspect account ${accountId}` })).toHaveCount(0)
    await page.getByRole('button', { name: 'Previous page' }).click()
    await page.getByRole('button', { name: `Inspect account ${accountId}` }).click()
    await expect(page).toHaveURL(new RegExp(`#accounts\\?accountId=${accountId}$`))
    await page.reload()
    await expect(page.getByRole('region', { name: 'Account detail' })).toContainText(accountId)
    await expect(page.getByText('customer@example.org', { exact: false })).toBeVisible()
    await expect(page.getByText('Private build title')).toHaveCount(0)
    await page.getByRole('combobox', { name: 'Cloud access' }).selectOption('read-only')
    await page.getByRole('button', { name: 'Preview access change' }).click()
    await expect(page.getByRole('dialog')).toContainText(accountId)
    await expect(page.getByRole('dialog')).toContainText(base.slice('https://'.length))
    await page.getByRole('button', { name: 'Apply action' }).click()
    await expect(page.getByRole('dialog')).toContainText('Complete')
    expect(await service.db.prepare('SELECT access FROM accounts WHERE id=?').bind(accountId).first('access')).toBe('read-only')
    const upload = await page.request.post(`${base}/api/v1/sync/uploads`, { headers: { cookie: `__Host-crykit-session=${token}`, origin: base, 'x-csrf-token': await keyedHash(service.env.SESSION_SECRET, 'customer-csrf', sessionId) }, data: { version: 1, uploadId: id(), documentId: id(), revisionId: id(), metadataBytes: 1, chunks: [{ index: 0, cipherBytes: 17, cipherDigest: randomBytes(32).toString('base64url') }] } })
    expect(upload.status()).toBe(403)
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('heading', { name: 'Accounts' })).toBeFocused()
    await page.getByRole('link', { name: 'Sharing' }).click()
    await page.getByRole('combobox', { name: 'State' }).selectOption('stopped')
    await expect(page.getByRole('button', { name: `Inspect share ${shareId}` })).toHaveCount(0)
    await page.getByRole('button', { name: 'Reset filters' }).click()
    await page.getByRole('button', { name: `Inspect share ${shareId}` }).click()
    await expect(page).toHaveURL(new RegExp(`#sharing\\?shareId=${shareId}$`))
    await expect(page.getByText('Build: Intentional public snapshot', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Preview link revocation' }).click()
    const popupPromise = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Apply action' }).click()
    const popup = await popupPromise
    expect(popup.url()).toContain('/admin/confirm/')
    await expect(page.getByRole('dialog')).toContainText('Accepted and queued')
    expect((await page.request.get(`${base}/api/public/v1/shares/${shareId}`)).status()).toBe(404)
    await page.getByRole('button', { name: 'Close' }).click()
    await page.getByRole('link', { name: 'Service settings' }).click()
    await expect(page.getByRole('heading', { name: 'Service settings' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pause registration' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Maximum account quota unit' }).selectOption('Bytes')
    await page.getByRole('textbox', { name: 'Maximum account quota' }).fill('1024')
    await expect(page.getByRole('list').filter({ hasText: 'Maximum account quota' })).toBeVisible()
    await page.getByRole('button', { name: 'Preview settings change' }).click()
    await expect(page.getByRole('dialog')).toContainText('service.settings')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Preview settings change' })).toBeFocused()
    await expect(page.getByRole('button', { name: 'Reset draft' })).toBeEnabled()
    await page.getByRole('button', { name: 'Reset draft' }).click()
    await expect(page.getByText('No changes to preview.')).toBeVisible()
    await page.getByRole('button', { name: 'Pause registration' }).click()
    await expect(page.getByRole('dialog')).toContainText('service.settings')
    await expect(page.getByRole('dialog')).toContainText('Registration: Paused')
    await expect(page.getByRole('dialog')).toContainText('New account registration stops; existing accounts keep access.')
    const settingsPopup = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Apply action' }).click()
    await settingsPopup
    await expect(page.getByRole('dialog')).toContainText('Complete')
    expect(await service.db.prepare("SELECT registration_paused FROM service_settings WHERE id='service'").first('registration_paused')).toBe(1)
    await page.getByRole('button', { name: 'Close' }).click()
    await expect(page.getByRole('button', { name: 'Resume registration' })).toBeVisible()
    await expect(page.getByText('No changes to preview.')).toBeVisible()
    await expect(page.getByText('Observed revision 2', { exact: false })).toBeVisible()
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark')
    await page.setViewportSize({ width: 375, height: 740 })
    await page.getByRole('link', { name: 'Jobs and email' }).focus()
    await expect(page.getByRole('link', { name: 'Jobs and email' })).toBeFocused()
    await page.getByRole('link', { name: 'Jobs and email' }).click()
    await expect(page.getByRole('heading', { name: 'Jobs and email' })).toBeVisible()
    await page.getByRole('combobox', { name: 'Type' }).selectOption('email')
    await expect(page.getByRole('button', { name: `Inspect job ${emailJobId}` })).toBeVisible()
    await expect(page.getByRole('button', { name: `Inspect job ${serviceJobId}` })).toHaveCount(0)
    await page.getByRole('button', { name: 'Reset filters' }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.getByRole('link', { name: 'Audit and access' }).click()
    await page.getByRole('textbox', { name: 'Verified email' }).fill('invitee@example.org')
    await page.getByRole('button', { name: 'Preview invitation' }).click()
    await expect(page.getByRole('dialog')).toContainText('Access policy')
    const invitePopup = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Apply action' }).click()
    await invitePopup
    await expect(page.getByRole('dialog')).toContainText('Accepted and queued')
    service.advance(Math.max(1000, Date.now() - now + 1000))
    await service.runJobs()
    const captured = await service.emails()
    expect(captured).toEqual([expect.objectContaining({ kind: 'admin-invite', recipient: 'invitee@example.org' })])
    const invitee = await browser.newContext({ ignoreHTTPSErrors: true, extraHTTPHeaders: { 'x-test-principal': 'invitee' } })
    try {
      const landing = await invitee.newPage()
      await landing.goto(`${base}/admin/accept-invitation/#${captured[0].capability}`)
      await expect(landing).toHaveURL(`${base}/admin/accept-invitation/`)
      await landing.getByRole('button', { name: 'Check Access session' }).click()
      await landing.getByRole('button', { name: 'Accept invitation' }).click()
      await expect(landing.getByRole('heading', { name: 'Overview' })).toBeVisible()
      await expect(landing.getByText('administrator session')).toBeVisible()
      expect(await service.db.prepare("SELECT COUNT(*) AS n FROM operators WHERE subject='synthetic-invitee' AND state='active'").first('n')).toBe(1)
    } finally { await invitee.close() }
    const guest = await browser.newPage({ ignoreHTTPSErrors: true })
    try { await guest.goto(base); await expect(guest).toHaveTitle(/CryKit/) } finally { await guest.close() }
  } finally {
    await service?.dispose()
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
