import { afterEach, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'
import { createAccessIssuer } from '../testing/access-issuer'
import { randomId } from '../auth/identity'

const fixtures: ServiceFixture[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(f => f.dispose())) })
it('servesEachEntryOnlyUnderItsOwnSignedAuthority', async () => {
  const issuer = createAccessIssuer(), now = Date.now()
  const f = await createServiceFixture({ production: true, now, assets: { directory: 'dist', run_worker_first: ['/api/*', '/admin', '/admin/*'] }, adminConfig: JSON.stringify({ version: 1, issuer: issuer.issuer, jwksUrl: `${issuer.issuer}/cdn-cgi/access/certs`, adminAudience: 'ordinary-admin', confirmationAudience: 'action-confirmation', confirmationEnabled: true }), accessKeys: async () => Response.json(issuer.jwks) })
  fixtures.push(f)
  const ordinary = { 'cf-access-jwt-assertion': issuer.token(now) }
  expect((await f.request('/admin/', { headers: ordinary })).status).toBe(403)
  expect((await f.request('/admin/accept-invitation/', { headers: ordinary })).status).toBe(200)
  expect((await f.request('/admin/confirm/', { headers: ordinary })).status).toBe(401)
  const confirmed = { 'cf-access-jwt-assertion': issuer.token(now, { aud: ['action-confirmation'], exp: Math.floor(now / 1000) + 900 }) }
  expect((await f.request('/admin/confirm/', { headers: confirmed })).status).toBe(403)
  await f.db.prepare("INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,?,'synthetic-owner','owner@example.org','owner','active',1,?)").bind(randomId(), issuer.issuer, now).run()
  const admin = await f.request('/admin/', { headers: ordinary })
  expect(admin.status).toBe(200)
  expect(admin.headers.get('cache-control')).toBe('no-store')
  expect(await admin.text()).toContain('Crystal Kit administration')
  const html = await readFile('dist/admin/index.html', 'utf8')
  const asset = /src="(\/admin\/assets\/[^\"]+\.js)"/.exec(html)?.[1]
  expect(asset).toBeTruthy()
  expect((await f.request(asset!, { headers: ordinary })).status).toBe(200)
  expect((await f.request(asset!, { headers: confirmed })).status).toBe(401)
  expect((await f.request('/', { headers: {} })).status).toBe(200)
})
