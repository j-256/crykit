import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { transformWithOxc } from 'vite'
import { nativeFixtureHost } from '../testing/native-loopback'

const runtimes: Miniflare[] = []
const codeVersion = 'a'.repeat(64)
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())) })

async function fixture(metadata: Partial<{ QUALIFICATION_RUN_ID: string; QUALIFICATION_CODE_VERSION: string }> = {}) {
  const source = await readFile(resolve('worker/operations/qualification-runner.ts'), 'utf8')
  // Compile this separate entry directly so a serving bundle or local fixture cannot substitute its interface
  const { code } = await transformWithOxc(source, 'qualification-runner.ts')
  const runtime = new Miniflare(convertV4MiniflareOptions({ host: nativeFixtureHost(), port: 0, workers: [
    { name: 'control', modules: true, compatibilityDate: '2026-09-28', script: 'export default { fetch() { return new Response(null, { status: 404 }) } }', serviceBindings: { OPS: { name: 'ops', entrypoint: 'QualificationOps' } } },
    { name: 'ops', modules: true, compatibilityDate: '2026-09-28', script: code, bindings: { QUALIFICATION_RUN_ID: 'synthetic-run', QUALIFICATION_CODE_VERSION: codeVersion, UNRELATED_SECRET: 'synthetic-private-value', ...metadata } },
  ] }))
  runtimes.push(runtime)
  const bindings = await runtime.getBindings('control') as { OPS: { status(): Promise<unknown>; run(): Promise<unknown> } }
  return { runtime, ops: bindings.OPS }
}

it('reports only bounded qualification identity over the named RPC entrypoint', async () => {
  const { ops } = await fixture()
  const first = await ops.status()
  expect(first).toEqual({ version: 1, service: 'crykit-qualification-ops', mode: 'inert', runId: 'synthetic-run', codeVersion })
  expect(JSON.stringify(first)).not.toContain('synthetic-private-value')
  expect(await ops.status()).toEqual(first)
})

it('exposes no HTTP status or operational command interface', async () => {
  const { runtime } = await fixture()
  const worker = await runtime.getWorker('ops')
  for (const path of ['/', '/status', '/run', '/notice', '/__fixtures', '/api/operations']) {
    for (const method of ['GET', 'POST']) {
      const response = await worker.fetch(`https://qualification.invalid${path}`, { method })
      expect(response.status, `${method} ${path}`).toBe(404)
      expect(await response.text()).toBe('')
    }
  }
})

it('does not expose a mutation command through the named RPC entrypoint', async () => {
  const { ops } = await fixture()
  await expect(async () => ops.run()).rejects.toThrow('does not implement the method "run"')
})

it.each([
  { QUALIFICATION_RUN_ID: '' },
  { QUALIFICATION_RUN_ID: 'invalid/run' },
  { QUALIFICATION_RUN_ID: 'r'.repeat(65) },
  { QUALIFICATION_CODE_VERSION: '' },
  { QUALIFICATION_CODE_VERSION: 'not-a-build-digest' },
])('refuses unqualified metadata without echoing configuration values: %j', async metadata => {
  const { ops } = await fixture(metadata)
  await expect(async () => ops.status()).rejects.toThrow('QUALIFICATION_PROBE_UNAVAILABLE')
})
