import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { createServer as httpServer, request } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountConnectivity } from '../e2e/accounts/network-fixture.ts'

let directory, trusted, unrelated
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'crykit-network-boundary-'))
  const config = join(directory, 'openssl.cnf')
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n')
  const certificate = async name => {
    const key = join(directory, `${name}.key`), cert = join(directory, `${name}.pem`)
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', key, '-out', cert], { stdio: 'ignore' })
    return { key: await readFile(key), cert: await readFile(cert, 'utf8') }
  }
  trusted = await certificate('trusted')
  unrelated = await certificate('unrelated')
})
after(async () => { await rm(directory, { recursive: true, force: true }) })

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    async dispose() { await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() }) },
  }
}

test('the connectivity proxy accepts its owned upstream certificate', async () => {
  const upstream = await listen(httpsServer(trusted, (_request, response) => response.writeHead(200).end()))
  try {
    const proxy = await accountConnectivity(`https://127.0.0.1:${upstream.port}`, trusted.cert)
    await proxy.dispose()
  } finally { await upstream.dispose() }
})

test('the connectivity proxy rejects a certificate outside its explicit trust', async () => {
  const upstream = await listen(httpsServer(trusted, (_request, response) => response.writeHead(200).end()))
  try {
    await assert.rejects(async () => {
      const proxy = await accountConnectivity(`https://127.0.0.1:${upstream.port}`, unrelated.cert)
      await proxy.dispose()
    }, /certificate|self.signed/i)
  } finally { await upstream.dispose() }
})

test('the connectivity proxy rejects a hostname alias instead of resolving it', async () => {
  const upstream = await listen(httpServer((_request, response) => response.writeHead(200).end()))
  try {
    await assert.rejects(async () => {
      const proxy = await accountConnectivity(`http://localhost:${upstream.port}`)
      await proxy.dispose()
    }, /loopback|owned/i)
  } finally { await upstream.dispose() }
})

test('an incoming absolute URL cannot redirect the proxy to another listener', async () => {
  let trapRequests = 0
  const trap = await listen(httpServer((_request, response) => { trapRequests++; response.end('private') }))
  const upstream = await listen(httpServer((_request, response) => response.writeHead(200).end()))
  const proxy = await accountConnectivity(`http://127.0.0.1:${upstream.port}`)
  try {
    const result = await new Promise((resolve, reject) => {
      const outgoing = request(proxy.origin, { path: `http://127.0.0.1:${trap.port}/private` }, response => {
        response.resume(); response.on('end', () => resolve(response.statusCode))
      })
      outgoing.on('error', reject); outgoing.end()
    })
    assert.equal(result, 400)
    assert.equal(trapRequests, 0)
  } finally { await proxy.dispose(); await upstream.dispose(); await trap.dispose() }
})
