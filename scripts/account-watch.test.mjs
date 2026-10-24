import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WATCH_READY_TIMEOUT_MS = 30_000
const WATCH_RERUN_TIMEOUT_MS = 15_000
const WATCH_CONTRACT_TIMEOUT_MS = 120_000

test('watch rebuilds bundle-only Worker changes before rerunning the fixture', { timeout: WATCH_CONTRACT_TIMEOUT_MS }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-account-watch-'))
  let child
  try {
    await mkdir(join(directory, 'scripts'))
    await cp(join(root, 'worker'), join(directory, 'worker'), { recursive: true })
    for (const path of ['package.json', 'package-lock.json', 'wrangler.local.jsonc', 'wrangler.alerts.example.jsonc', 'scripts/build-account-tests.mjs', 'scripts/opaque-worker-module.mjs']) await cp(join(root, path), join(directory, path))
    // Include the Worker's shared runtime schemas so its real bundle can reach the watch assertions
    for (const path of ['src/account/protocol.ts', 'src/account/admin-protocol.ts', 'src/account/deletion-protocol.ts', 'src/account/storage-protocol.ts', 'src/account/shares-protocol.ts', 'src/interchange/public-share-schema.ts']) {
      await mkdir(dirname(join(directory, path)), { recursive: true })
      await cp(join(root, path), join(directory, path))
    }
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
    // Use the real watch configuration and command while edits stay inside a disposable copy
    await writeFile(join(directory, 'vite.config.ts'), `import config from ${JSON.stringify(join(root, 'vite.config.ts'))}\nexport default { ...config, root: ${JSON.stringify(directory)} }\n`)
    child = spawn('npm', ['run', 'test:watch', '--', '--watch', '--project', 'worker', 'worker/runtime.test.ts', '-t', 'controlsClockFaultsAndCapturesOnlyLocalEventsAndEmail'], { cwd: directory, env: { ...process.env, CI: '', NO_COLOR: '1' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    const collect = data => { output += data.toString().replace(/\x1b\[[0-9;]*m/g, '') }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    function waitFor(pattern, start = 0, budgetMs = WATCH_READY_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Missing ${pattern}:\n${output.slice(-3000)}`)), budgetMs)
        const inspect = () => { if (pattern.test(output.slice(start))) finish() }
        const exited = () => finish(new Error(`Watch exited before ${pattern}:\n${output.slice(-3000)}`))
        const finish = error => {
          clearTimeout(timer)
          child.stdout.off('data', inspect)
          child.stderr.off('data', inspect)
          child.off('close', exited)
          error ? reject(error) : resolve()
        }
        child.stdout.on('data', inspect)
        child.stderr.on('data', inspect)
        child.once('close', exited)
        inspect()
      })
    }
    await waitFor(/(?:Waiting|Watching) for file changes/)
    assert.match(output, /Tests\s+1 passed/)
    const entry = join(directory, 'worker/testing/local-entry.ts')
    const original = await readFile(entry, 'utf8')
    const changed = original.replace('now: context.now()', 'now: context.now() + 1')
    assert.notEqual(changed, original, 'The mutation must affect the bundle-only clock route')
    let start = output.length
    await writeFile(entry, changed)
    // Missing source watching times out; missing rebuilding reruns stale passing code
    await waitFor(/Tests\s+1 failed/, start, WATCH_RERUN_TIMEOUT_MS)
    await waitFor(/(?:Waiting|Watching) for file changes/, start)
    assert.match(output.slice(start), /1251/)
    start = output.length
    await writeFile(entry, original)
    await waitFor(/Tests\s+1 passed/, start, WATCH_RERUN_TIMEOUT_MS)
    await waitFor(/(?:Waiting|Watching) for file changes/, start)
    start = output.length
    const generator = join(directory, 'scripts/opaque-worker-module.mjs')
    await writeFile(generator, (await readFile(generator, 'utf8')) + '\n')
    await waitFor(/Tests\s+1 passed/, start, WATCH_RERUN_TIMEOUT_MS)
    await waitFor(/(?:Waiting|Watching) for file changes/, start)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      // The dedicated process group contains only this test's npm/Vitest/build children
      const closed = once(child, 'close')
      process.kill(-child.pid, 'SIGTERM')
      await closed
    }
    await rm(directory, { recursive: true, force: true })
  }
})
