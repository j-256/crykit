import { createServer, type Server } from 'node:https'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, test } from '@playwright/test'
import { createServiceFixture, type ServiceFixture } from '../../worker/testing/service-fixture'
import { encryptRevision } from '../../src/account/crypto/revisions'
import { createAccessIssuer } from '../../worker/testing/access-issuer'

const id = () => randomBytes(16).toString('base64url')
const keyedHash = async (secret: string, purpose: string, value: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.from(secret, 'base64url'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return Buffer.from(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify([1, purpose, value]))),
  ).toString('base64url')
}
test('adminCannotFetchAnotherAccountsPrivateObjects', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-admin-security-'))
  let service: ServiceFixture | undefined
  let server: Server | undefined
  const observed: string[] = [], downloads: string[] = []
  try {
    const key = join(directory, 'key.pem'),
      cert = join(directory, 'cert.pem'),
      config = join(directory, 'openssl.cnf')
    await writeFile(
      config,
      '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n',
    )
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-config',
        config,
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { stdio: 'ignore' },
    )
    const runtimeLogs: string[] = []
    const issuer = createAccessIssuer(),
      now = Date.now()
    server = createServer(
      { key: await readFile(key), cert: await readFile(cert) },
      async (request, response) => {
        if (!service) {
          response.writeHead(503).end()
          return
        }
        try {
          const path = request.url ?? '/'
          const headers = new Headers()
          for (const name of ['cookie', 'origin', 'content-type', 'x-csrf-token', 'accept']) {
            const value = request.headers[name]
            if (typeof value === 'string') headers.set(name, value)
          }
          const invitee = request.headers['x-test-principal'] === 'invitee'
          const claims = invitee ? { sub: 'synthetic-invitee', email: 'invitee@example.org' } : {}
          headers.set(
            'cf-access-jwt-assertion',
            path.startsWith('/admin/confirm/')
              ? issuer.token(now, {
                  ...claims,
                  aud: ['action-confirmation'],
                  exp: Math.floor(now / 1000) + 900,
                })
              : issuer.token(now, claims),
          )
          const parts: Buffer[] = []
          for await (const part of request) parts.push(Buffer.from(part))
          const result = await service.request(path, {
            method: request.method,
            headers,
            ...(parts.length ? { body: Buffer.concat(parts) } : {}),
          })
          const bytes = Buffer.from(await result.arrayBuffer())
          // Capture the actual served bytes before navigation can evict WebKit's protocol response body
          if (path.startsWith('/api/admin/')) observed.push(bytes.toString('utf8'))
          response.writeHead(result.status, Object.fromEntries(result.headers))
          response.end(bytes)
        } catch {
          response.writeHead(503).end()
        }
      },
    )
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Synthetic server address unavailable')
    const base = `https://127.0.0.1:${address.port}`
    service = await createServiceFixture({
      production: true,
      onLog: (value) => runtimeLogs.push(JSON.stringify(value)),
      serviceOrigin: base,
      now,
      assets: { directory: 'dist', run_worker_first: ['/api/*', '/admin', '/admin/*'] },
      adminConfig: JSON.stringify({
        version: 1,
        issuer: issuer.issuer,
        jwksUrl: `${issuer.issuer}/cdn-cgi/access/certs`,
        adminAudience: 'ordinary-admin',
        confirmationAudience: 'action-confirmation',
        confirmationEnabled: true,
      }),
      accessKeys: async () => Response.json(issuer.jwks),
    })
    const accountId = id(),
      operatorId = id(),
      deviceId = id(),
      sessionId = id(),
      token = randomBytes(32).toString('base64url')
    await service.db
      .prepare(
        "INSERT INTO operators(id,issuer,subject,email,role,state,revision,created_at) VALUES (?,?,'synthetic-owner','owner@example.org','owner','active',1,?)",
      )
      .bind(operatorId, issuer.issuer, now)
      .run()
    await service.db
      .prepare(
        "INSERT INTO accounts(id,normalized_email,delivery_email,username,verified_at,capacity_bytes,created_at) VALUES (?,'customer@example.org','customer@example.org','synthetic',?,1000000,?)",
      )
      .bind(accountId, now, now)
      .run()
    await service.db
      .prepare('INSERT INTO devices(id,account_id,created_at) VALUES (?,?,?)')
      .bind(deviceId, accountId, now)
      .run()
    await service.db
      .prepare(
        'INSERT INTO customer_sessions(id,token_hash,account_id,device_id,authenticated_at,idle_expires_at,absolute_expires_at,remembered) VALUES (?,?,?,?,?,?,?,0)',
      )
      .bind(
        sessionId,
        await keyedHash(service.env.SESSION_SECRET, 'customer-session', token),
        accountId,
        deviceId,
        now,
        now + 3_600_000,
        now + 3_600_000,
      )
      .run()
    const privateSentinel = `private-build-file-category-${id()}`,
      accountKey = new Uint8Array(randomBytes(32))
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ name: privateSentinel, file: privateSentinel, category: privateSentinel }),
    )
    const chunks: Uint8Array[] = []
    const { descriptor } = await encryptRevision(
      accountKey,
      {
        format: 1,
        accountId,
        documentId: id(),
        revisionId: id(),
        parents: [],
        dependencies: [],
        protected: false,
        plainBytes: plaintext.length,
      },
      id(),
      (async function* () {
        yield plaintext
      })(),
      {
        id: 'synthetic-private-stage',
        async write(_index, bytes) {
          chunks.push(bytes.slice())
        },
      },
    )
    const customerHeaders = {
      cookie: `__Host-crykit-session=${token}`,
      origin: base,
      'x-csrf-token': await keyedHash(service.env.SESSION_SECRET, 'customer-csrf', sessionId),
      'content-type': 'application/json',
    }
    const customerPost = (path: string, input: unknown) =>
      service!.request(`/api/v1/${path}`, {
        method: 'POST',
        headers: customerHeaders,
        body: JSON.stringify(input),
      })
    expect(
      (
        await customerPost('sync/uploads', {
          version: 1,
          uploadId: descriptor.uploadId,
          documentId: descriptor.documentId,
          revisionId: descriptor.revisionId,
          metadataBytes: JSON.stringify(descriptor).length,
          chunks: descriptor.chunks,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await service.request(`/api/v1/sync/uploads/${descriptor.uploadId}/chunks/0`, {
          method: 'PUT',
          headers: { ...customerHeaders, 'content-type': 'application/octet-stream' },
          body: Buffer.from(chunks[0]),
        })
      ).status,
    ).toBe(200)
    expect((await customerPost(`sync/uploads/${descriptor.uploadId}/finish`, { version: 1 })).status).toBe(
      200,
    )
    expect(
      (
        await customerPost('sync/commits', {
          version: 1,
          mutationId: id(),
          revisions: [descriptor],
          heads: [{ documentId: descriptor.documentId, revisionId: descriptor.revisionId }],
          expected: [{ documentId: descriptor.documentId, revisionId: null }],
        })
      ).status,
    ).toBe(200)
    page.on('console', (message) => observed.push(message.text()))
    page.on('pageerror', (error) => observed.push(error.message))
    page.on('download', (download) => downloads.push(download.suggestedFilename()))
    await page.goto(`${base}/admin/`)
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible()
    await page.getByRole('link', { name: 'Accounts' }).click()
    await page.getByRole('button', { name: `Inspect account ${accountId}` }).click()
    await expect(page.getByText('customer@example.org', { exact: false })).toBeVisible()
    expect(
      await service.db
        .prepare("SELECT count(*) AS n FROM admin_audit WHERE action='accounts.detail' AND target_id=?")
        .bind(accountId)
        .first('n'),
    ).toBe(1)
    const privateRead = await page.request.get(
      `${base}/api/v1/sync/revisions/${descriptor.revisionId}/chunks/0`,
    )
    expect(privateRead.status()).toBe(401)
    const metadataRead = await page.request.get(`${base}/api/v1/sync/revisions/${descriptor.revisionId}`)
    expect(metadataRead.status()).toBe(401)
    // A valid customer can still read the exact immutable ciphertext through the ordinary API
    const customerRead = await service.request(`/api/v1/sync/revisions/${descriptor.revisionId}/chunks/0`, {
      headers: customerHeaders,
    })
    expect(customerRead.status).toBe(200)
    expect(Buffer.from(await customerRead.arrayBuffer())).toEqual(Buffer.from(chunks[0]))
    for (const name of ['Sharing', 'Jobs and email', 'Service settings', 'Audit and access'])
      await page.getByRole('link', { name }).click()
    observed.push(
      await page.content(),
      JSON.stringify(runtimeLogs),
      JSON.stringify(downloads),
      await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
      ),
    )
    for (const secret of [
      privateSentinel,
      Buffer.from(accountKey).toString('base64url'),
      descriptor.keyEnvelope.ciphertext,
      descriptor.streamHeader,
    ])
      expect(observed.join('\n')).not.toContain(secret)
    expect(runtimeLogs.join('\n')).toContain('AUTH_REQUIRED')
    expect(downloads).toEqual([])
  } finally {
    // The fixture owns these keep-alive connections; close them before disposing their Worker
    if (server) await new Promise<void>((resolve) => { server!.close(() => resolve()); server!.closeAllConnections() })
    await service?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
