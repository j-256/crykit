import { expect } from 'vitest'
import { createServiceFixture, type FixtureOptions } from './service-fixture'
import { createAccessIssuer } from './access-issuer'
import { randomId } from '../auth/identity'
import type { AdminCommand } from '../../src/account/admin-protocol'

export const adminTestNow = 1_800_000_000_000
export async function adminFixture(options: FixtureOptions = {}) {
  const issuer = createAccessIssuer()
  const config = {
    version: 1,
    issuer: issuer.issuer,
    jwksUrl: `${issuer.issuer}/cdn-cgi/access/certs`,
    adminAudience: 'ordinary-admin',
    confirmationAudience: 'action-confirmation',
    confirmationEnabled: true,
  }
  const f = await createServiceFixture({
    now: adminTestNow,
    adminConfig: JSON.stringify(config),
    accessKeys: async () => Response.json(issuer.jwks),
    ...options,
  })
  const operatorId = randomId()
  await f.db
    .prepare(
      "INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,?,'synthetic-owner','owner@example.org','owner','active',1,?)",
    )
    .bind(operatorId, issuer.issuer, adminTestNow)
    .run()
  const response = await f.request('/api/admin/v1/session', {
    headers: { 'cf-access-jwt-assertion': issuer.token(adminTestNow) },
  })
  expect(response.status).toBe(200)
  const session = (await response.json()) as {
    csrf: string
    sessionId: string
  }
  const headers = {
    'cf-access-jwt-assertion': issuer.token(adminTestNow),
    cookie: response.headers.get('set-cookie')!.split(';')[0],
    origin: 'http://127.0.0.1',
    'x-csrf-token': session.csrf,
    'content-type': 'application/json',
  }
  const post = (path: string, body: unknown, override = headers) =>
    f.request('/api/admin/v1/' + path, {
      method: 'POST',
      headers: override,
      body: JSON.stringify(body),
    })
  async function confirm(input: AdminCommand) {
    const preview = await post('actions/preview', input)
    expect(preview.status).toBe(200)
    const { commandDigest } = (await preview.json()) as {
      commandDigest: string
    }
    const challenge = await post('confirmations', { commandDigest })
    expect(challenge.status).toBe(200)
    const { challengeId } = (await challenge.json()) as { challengeId: string }
    expect(
      (
        await f.request('/admin/confirm/api/v1/complete', {
          method: 'POST',
          headers: {
            ...headers,
            'cf-access-jwt-assertion': issuer.token(adminTestNow, {
              aud: ['action-confirmation'],
              exp: adminTestNow / 1000 + 900,
            }),
          },
          body: JSON.stringify({ challengeId }),
        })
      ).status,
    ).toBe(200)
  }
  return { f, issuer, config, operatorId, headers, session, post, confirm }
}
export function adminCommand(
  command: AdminCommand['command'],
  target: AdminCommand['target'],
  expectedRevision = 1,
): AdminCommand {
  return {
    version: 1,
    actionId: randomId(),
    expectedRevision,
    target,
    reason: 'support',
    command,
  }
}
