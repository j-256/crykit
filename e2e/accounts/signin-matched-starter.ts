import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { z } from 'zod'
import type { Page, TestInfo } from '@playwright/test'
import { MATCHED_STARTER_METHOD, requirePreeditStarter } from './signin-matched-starter-core'
import { MAX_STARTER_GRAPH_RECORDS, canonical, digest, proveOrdinaryStarterEdit, proveStarterInitialization, type StarterGraph, type StarterReference } from './signin-matched-starter-graph'

const file = z.strictObject({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
const module = file.extend({ exported: z.string().min(1), property: z.string().optional() })
const modules = z.strictObject({ GuestCoordinatorDatabase: module, getDatabase: module, createGuestLocalStore: module, prepareLocalWorkspace: module, admitLocalRoot: module, captureGuestWorkspaceEpoch: module, readWorkspaceBackup: module, disposeWorkspaceSnapshot: module })
const configSchema = z.strictObject({ method: z.literal(MATCHED_STARTER_METHOD), archive: file, reference: file, variants: z.strictObject({ baseline: modules, candidate: modules }) })
const ROUTE = '/__matched-starter-setup/'
const MAX_GRAPH_BYTES = 16 * 1024 * 1024
export function requirePinnedBytes(bytes: Uint8Array, expected: string) { assert.equal(digest(bytes), expected, 'Frozen starter bytes changed'); return bytes }
export async function readMatchedStarterConfig(path: string) {
  const config = configSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  const archive = requirePinnedBytes(await readFile(config.archive.path), config.archive.sha256)
  const reference = JSON.parse(new TextDecoder().decode(requirePinnedBytes(await readFile(config.reference.path), config.reference.sha256))) as StarterReference
  assert.deepEqual(reference.bodyRefs, [], 'Frozen starter has unexpected native bodies')
  requirePreeditStarter({ ...reference.state, blobs: [] }, reference.destinationChanges)
  return { config, archive, reference }
}
async function captureGraph(page: Page, name: string): Promise<StarterGraph> {
  return page.evaluate(async ({ name, maxRecords, maxBytes }) => {
    if (!(await indexedDB.databases()).some(value => value.name === name)) throw new Error('Selected starter database disappeared')
    return new Promise<StarterGraph>((resolveGraph, reject) => {
      const open = indexedDB.open(name)
      open.onupgradeneeded = () => open.transaction?.abort()
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const database = open.result
        const names = ['active', 'managedRecords', 'managedChunks', 'managedOperations', 'captures', 'records', 'journal', 'managedMigrations']
        const transaction = database.transaction(names, 'readonly')
        const requests = Object.fromEntries(names.map(name => [name, transaction.objectStore(name).getAll()]))
        transaction.onabort = () => { database.close(); reject(transaction.error) }
        transaction.oncomplete = () => {
          database.close()
          try {
            const rows = requests.managedRecords.result, chunks = requests.managedChunks.result
            if (rows.length > maxRecords || chunks.reduce((sum, row) => sum + row.bytes.byteLength, 0) > maxBytes) throw new Error('Matched starter observation exceeded its narrow bound')
            if (requests.active.result.length !== 1 || requests.active.result[0].key !== 'active') throw new Error('Ambiguous starter selection')
            resolveGraph({ manifest: requests.active.result[0].manifest, records: rows, chunks: chunks.map(row => ({ revisionId: row.revisionId, index: row.index, bytes: Array.from(row.bytes as Uint8Array) })), operations: requests.managedOperations.result, extraCounts: Object.fromEntries(['captures', 'records', 'journal', 'managedMigrations'].map(name => [name, requests[name].result.length])) })
          } catch (error) { reject(error) }
        }
      }
    })
  }, { name, maxRecords: MAX_STARTER_GRAPH_RECORDS, maxBytes: MAX_GRAPH_BYTES })
}
// The shared adapter is served only by the owning test route; immutable application files are never patched
export async function prepareMatchedStarter(page: Page, testInfo: TestInfo, configPath: string) {
  const started = performance.now(), { config, archive, reference } = await readMatchedStarterConfig(configPath)
  const variant = process.env.CRYKIT_MEASUREMENT_BASELINE === '1' ? 'baseline' : 'candidate'
  const selectedModules = config.variants[variant], input = process.env.CRYKIT_ACCOUNT_INPUTS
  assert(input, 'Matched starter needs pinned immutable inputs')
  for (const spec of Object.values(selectedModules)) {
    assert(/^\/__accounts-proof\/assets\/[a-zA-Z0-9_-]+\.js$/.test(spec.path), 'Invalid starter module path')
    requirePinnedBytes(await readFile(resolve(input, 'assets', spec.path.slice(1))), spec.sha256)
  }
  const adapter = (await build({ entryPoints: [resolve('e2e/accounts/signin-matched-starter-browser.ts')], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2023', logLevel: 'silent' })).outputFiles[0].contents
  await page.route(`**${ROUTE}adapter.js`, route => route.fulfill({ contentType: 'application/javascript', body: Buffer.from(adapter) }))
  await page.route(`**${ROUTE}starter.crykit`, route => route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from(archive) }))
  await page.goto('/__accounts-proof/account-workspace.html?fixture-setup=1#/settings/account')
  await page.waitForFunction(() => !!(window as any).accountBootstrapProof)
  const installed = await page.evaluate(async ({ modules, url, changes }) => {
    const { installStarter } = await import(/* @vite-ignore */ url + 'adapter.js')
    return installStarter(modules, url + 'starter.crykit', changes)
  }, { modules: selectedModules, url: ROUTE, changes: reference.destinationChanges })
  const databaseName = await page.evaluate(async spec => {
    const module = await import(/* @vite-ignore */ spec.path)
    return module[spec.exported]().name + '-coordinator'
  }, selectedModules.getDatabase)
  assert.equal(await page.evaluate(async () => (await indexedDB.databases()).some(value => value.name?.startsWith('crykit-account-v1-'))), false, 'Matched setup initialized account storage')
  const before = await captureGraph(page, databaseName), initial = await proveStarterInitialization(before, reference)
  assert.deepEqual(before.manifest, installed.manifest)
  // Mount the unchanged app, then perform its genuine save against the admitted predecessor
  await page.goto('/__accounts-proof/account-workspace.html#/settings/account')
  await page.getByRole('button', { name: 'Continue using this device', exact: true }).click()
  await page.waitForFunction(() => !!(window as any).workspaceProof)
  await page.evaluate(() => (window as any).workspaceProof.seedDefaultGuestProgress())
  const after = await captureGraph(page, databaseName), edit = await proveOrdinaryStarterEdit(before, after, reference)
  assert.equal(await page.evaluate(async () => (await indexedDB.databases()).some(value => value.name?.startsWith('crykit-account-v1-'))), false, 'Ordinary starter save initialized account storage')
  await testInfo.attach('matched-starter-ordinary-edit', { body: JSON.stringify(edit), contentType: 'application/json' })
  await testInfo.attach('matched-starter-initial-graph', { body: JSON.stringify({ ...before, chunks: before.chunks.map(({ bytes, ...row }) => ({ ...row, byteLength: bytes.length, sha256: digest(Uint8Array.from(bytes)) })) }), contentType: 'application/json' })
  await page.unroute(`**${ROUTE}adapter.js`); await page.unroute(`**${ROUTE}starter.crykit`)
  const evidence = { method: MATCHED_STARTER_METHOD, archiveSha256: config.archive.sha256, referenceSha256: config.reference.sha256, adapterSha256: digest(adapter), modulePinsSha256: digest(canonical(selectedModules)), sourceStateSha256: initial.sourceStateSha256, operativeSha256: initial.operativeSha256, topologySha256: initial.topologySha256, initialRecordCount: initial.recordCount, exactPreeditState: true, ordinaryInitialization: true, ordinaryHistoryTransition: edit.transitionCount === 1, setupMs: performance.now() - started, readbackBoundary: 'before-timing-reload', selectedFence: after.manifest }
  // Full post-reload reads belong only to the separate setup qualification, never a timing sample
  return { evidence, async qualifyReloadPreservation() {
    assert.deepEqual(await captureGraph(page, databaseName), after, 'Reload changed the ordinary saved guest graph')
    assert.equal(await page.evaluate(async () => (await indexedDB.databases()).some(value => value.name?.startsWith('crykit-account-v1-'))), false, 'Setup or reload initialized account storage')
    return { reloadPreserved: true, reloadProofScope: 'separate-setup-qualification' } as const
  } }
}
