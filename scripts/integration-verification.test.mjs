import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPushVerification, verificationContext, verificationRecordPath, verifyIntegration } from './integration-verification.mjs'
import { coordinateVerification } from './verification-coordination.mjs'

const ZERO_OID = '0'.repeat(40)
const VERIFICATION_COMMANDS = ['prepare:verification', 'check:deterministic:base', 'test:vitest:prepared', 'test:e2e', 'test:e2e:accounts:prepared']
const scriptPath = name => fileURLToPath(new URL(name, import.meta.url))

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'crykit-verification-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const cwd = join(directory, 'checkout')
  mkdirSync(cwd)
  const env = { ...process.env, XDG_CACHE_HOME: join(directory, 'cache') }
  delete env.WT_QUEUE_VERIFICATION_TOKEN
  delete env.CRYKIT_WT_QUEUE
  const git = (args, location = cwd) => execFileSync('git', args, { cwd: location, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(['init', '--quiet', '--initial-branch=main'])
  git(['config', 'user.name', 'Synthetic maintainer'])
  git(['config', 'user.email', 'maintainer@example.com'])
  git(['config', 'core.hooksPath', '.no-hooks'])
  writeFileSync(join(cwd, 'fixture.txt'), 'Initial source\n')
  git(['add', 'fixture.txt'])
  git(['commit', '--quiet', '-m', 'Initial fixture', '--', 'fixture.txt'])
  const options = { cwd, env, run: async () => {}, report: () => {} }
  const input = (oid = git(['rev-parse', 'HEAD']), ref = 'main') => `refs/heads/${ref} ${oid} refs/heads/${ref} ${ZERO_OID}\n`
  return { directory, cwd, env, git, options, input }
}

test('only complete successful verification creates a record for the exact tree', async t => {
  const f = fixture(t)
  assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
  const commands = []
  const result = await verifyIntegration({ ...f.options, run: async command => { commands.push(command); assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/) } })
  assert.deepEqual(commands, VERIFICATION_COMMANDS)
  assert.equal(result.recorded, true)
  checkPushVerification(f.input(), f.options)
  f.git(['commit', '--quiet', '--allow-empty', '-m', 'Metadata only'])
  checkPushVerification(f.input(), f.options)
})

test('changed source invalidates verification, including after synchronization adds files', async t => {
  const f = fixture(t)
  await verifyIntegration(f.options)
  writeFileSync(join(f.cwd, 'fixture.txt'), 'Changed source\n')
  assert.throws(() => checkPushVerification(f.input(), f.options), /clean checkout/)
  f.git(['add', 'fixture.txt'])
  f.git(['commit', '--quiet', '-m', 'Synchronized source', '--', 'fixture.txt'])
  assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
  await verifyIntegration(f.options)
  checkPushVerification(f.input(), f.options)
})

test('queue-owned verification reuses only complete evidence for the exact clean tree and runtime', async t => {
  const f = fixture(t)
  await verifyIntegration(f.options)
  let executed = 0
  const options = { ...f.options, ifNeeded: true, run: async () => { executed++ } }
  assert.equal((await verifyIntegration(options)).reused, true)
  assert.equal(executed, 0)
  f.git(['commit', '--quiet', '--allow-empty', '-m', 'Metadata only'])
  assert.equal((await verifyIntegration(options)).reused, true)
  const path = verificationRecordPath(verificationContext(f.cwd, f.env))
  const valid = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...valid, runtime: { ...valid.runtime, node: 'different' } }))
  await verifyIntegration(options)
  assert.equal(executed, VERIFICATION_COMMANDS.length)
  writeFileSync(join(f.cwd, 'fixture.txt'), 'Unsaved source\n')
  assert.equal((await verifyIntegration(options)).recorded, false)
  assert.equal(executed, VERIFICATION_COMMANDS.length * 2)
  f.git(['add', 'fixture.txt'])
  f.git(['commit', '--quiet', '-m', 'Changed tree', '--', 'fixture.txt'])
  assert.equal((await verifyIntegration(options)).reused, undefined)
  assert.equal(executed, VERIFICATION_COMMANDS.length * 3)
})

test('coordination allows standalone clones but never falls back after a collision or invalid ownership', async t => {
  const f = fixture(t)
  const coordinator = join(f.directory, 'coordinator')
  const fake = source => {
    writeFileSync(coordinator, `#!${process.execPath}\n${source}\n`)
    chmodSync(coordinator, 0o755)
  }
  let direct = 0
  const run = async () => { direct++; return 'standalone' }
  const options = { cwd: f.cwd, env: { ...f.env, CRYKIT_WT_QUEUE: coordinator }, argv: ['synthetic-check'], report: () => {} }
  fake('process.exit(5)')
  assert.equal(await coordinateVerification(run, options), 'standalone')
  fake('process.exit(4)')
  await assert.rejects(coordinateVerification(run, options), error => error.exitCode === 4)
  assert.equal(direct, 1)
  fake('process.stdout.write(JSON.stringify({ action: "owned" }))')
  assert.equal(await coordinateVerification(run, { ...options, env: { ...options.env, WT_QUEUE_VERIFICATION_TOKEN: 'synthetic-token' } }), 'standalone')
  fake('process.stdout.write(JSON.stringify({ action: "run" }))')
  await assert.rejects(coordinateVerification(run, { ...options, env: { ...options.env, WT_QUEUE_VERIFICATION_TOKEN: 'synthetic-token' } }), /did not confirm ownership/)
  assert.equal(direct, 2)
  await assert.rejects(coordinateVerification(run, { ...options, env: { ...f.env, CRYKIT_WT_QUEUE: '/missing-selected-coordinator' } }), error => error.exitCode === 3)
  assert.equal(await coordinateVerification(run, { ...options, env: { ...f.env, PATH: '' } }), 'standalone')
})

test('failed and interrupted reruns invalidate earlier success before checks start', async t => {
  const f = fixture(t)
  for (const failedCommand of VERIFICATION_COMMANDS) {
    await verifyIntegration(f.options)
    const commands = []
    await assert.rejects(verifyIntegration({ ...f.options, run: async command => {
      commands.push(command)
      if (command === failedCommand) throw new Error('Synthetic failure or interruption')
    } }), /Synthetic failure/)
    const index = VERIFICATION_COMMANDS.indexOf(failedCommand)
    assert.deepEqual(commands, VERIFICATION_COMMANDS.slice(0, index < 3 ? index + 1 : 5))
    assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
  }
})

test('a failed prerequisite check prevents Vitest and browser startup and invalidates prior success', async t => {
  const f = fixture(t)
  await verifyIntegration(f.options)
  const commands = []
  await assert.rejects(verifyIntegration({ ...f.options, run: async command => {
    commands.push(command)
    if (command === 'check:deterministic:base') throw new Error('Synthetic source audit failure')
  } }), /Synthetic source audit failure/)
  assert.deepEqual(commands, VERIFICATION_COMMANDS.slice(0, 2))
  assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
})

test('prerequisites finish before Vitest and browser siblings overlap without publishing partial success', async t => {
  const f = fixture(t)
  const preparation = Promise.withResolvers()
  const checks = Promise.withResolvers()
  const vitest = Promise.withResolvers()
  const browsers = Promise.withResolvers()
  const checksStarted = Promise.withResolvers()
  const vitestStarted = Promise.withResolvers()
  const browsersStarted = Promise.withResolvers()
  const commands = []
  const pending = verifyIntegration({ ...f.options, run: async command => {
    commands.push(command)
    if (command === VERIFICATION_COMMANDS[0]) await preparation.promise
    else if (command === 'check:deterministic:base') {
      checksStarted.resolve()
      await checks.promise
    } else if (command === 'test:vitest:prepared') {
      vitestStarted.resolve()
      await vitest.promise
    } else {
      if (commands.length === 5) browsersStarted.resolve()
      await browsers.promise
    }
  } })
  try {
    assert.deepEqual(commands, VERIFICATION_COMMANDS.slice(0, 1))
    preparation.resolve()
    await checksStarted.promise
    assert.deepEqual(commands, VERIFICATION_COMMANDS.slice(0, 2))
    assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
    checks.resolve()
    await vitestStarted.promise
    assert.deepEqual(commands, VERIFICATION_COMMANDS.slice(0, 3))
    assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
    vitest.resolve()
    await browsersStarted.promise
    assert.deepEqual(commands, VERIFICATION_COMMANDS)
    assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
    browsers.resolve()
    assert.equal((await pending).recorded, true)
    checkPushVerification(f.input(), f.options)
  } finally { preparation.resolve(); checks.resolve(); vitest.resolve(); browsers.resolve(); await pending }
})

test('a failed browser lane drains its running sibling and prevents publication', async t => {
  const f = fixture(t)
  const phase = VERIFICATION_COMMANDS.slice(3)
  for (const failedCommand of phase) {
    await verifyIntegration(f.options)
    const sibling = Promise.withResolvers()
    const commands = []
    let settled = false
    const pending = verifyIntegration({ ...f.options, run: async command => {
      commands.push(command)
      if (command === failedCommand) throw new Error(`Synthetic ${command} failure`)
      if (phase.includes(command)) await sibling.promise
    } })
    pending.then(() => { settled = true }, () => { settled = true })
    const rejected = assert.rejects(pending, new RegExp(`Synthetic ${failedCommand} failure`))
    try {
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(settled, false)
      assert.deepEqual(commands, VERIFICATION_COMMANDS)
      assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
      sibling.resolve()
      await rejected
      assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
    } finally { sibling.resolve(); await rejected }
  }
})

test('real npm prerequisites finish before Vitest and archives finish before concurrent browsers', async t => {
  const f = fixture(t)
  const events = join(f.directory, 'events')
  mkdirSync(events)
  const stages = ['prepare', 'checks', 'vitest', 'browser', 'accounts']
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(VERIFICATION_COMMANDS.map((command, i) => [command, `node stages.mjs ${stages[i]}`])) }))
  writeFileSync(join(f.cwd, 'stages.mjs'), `
import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
const READY_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 10
const marker = name => join(process.env.CRYKIT_VERIFICATION_FIXTURE, name)
const mark = name => writeFileSync(marker(name), 'Passed')
const stage = process.argv[2]
if (stage === 'prepare') mark('prepared')
else {
  assert.ok(existsSync(marker('prepared')))
  const names = ['browser', 'accounts']
  if (stage === 'checks') assert.equal(existsSync(marker('vitest')), false)
  else assert.ok(existsSync(marker('checks-passed')))
  if (names.includes(stage)) assert.ok(existsSync(marker('vitest-passed')))
  else for (const name of names) assert.equal(existsSync(marker(name)), false)
  mark(stage)
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (const name of names.includes(stage) ? names : []) {
    while (!existsSync(marker(name))) {
      if (Date.now() > deadline) throw new Error('Verification did not overlap: ' + name)
      await setTimeout(POLL_INTERVAL_MS)
    }
  }
  mark(stage + '-passed')
}
`)
  f.git(['add', 'package.json', 'stages.mjs'])
  f.git(['commit', '--quiet', '-m', 'Synthetic verification stages', '--', 'package.json', 'stages.mjs'])
  const result = await verifyIntegration({ cwd: f.cwd, env: { ...f.env, CRYKIT_VERIFICATION_FIXTURE: events }, report: () => {} })
  assert.equal(result.recorded, true)
  checkPushVerification(f.input(), f.options)
})

test('a real npm prerequisite failure leaves long consumers unstarted and publication blocked', async t => {
  const f = fixture(t)
  const events = join(f.directory, 'events')
  mkdirSync(events)
  const stages = ['prepare', 'checks', 'vitest', 'browser', 'accounts']
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(VERIFICATION_COMMANDS.map((command, i) => [command, `node stages.mjs ${stages[i]}`])) }))
  writeFileSync(join(f.cwd, 'stages.mjs'), `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const stage = process.argv[2]
writeFileSync(join(process.env.CRYKIT_VERIFICATION_FIXTURE, stage), 'Started')
if (stage === 'checks') throw new Error('Synthetic source audit failure')
`)
  f.git(['add', 'package.json', 'stages.mjs'])
  f.git(['commit', '--quiet', '-m', 'Synthetic failing prerequisite', '--', 'package.json', 'stages.mjs'])
  await verifyIntegration(f.options)
  await assert.rejects(verifyIntegration({ cwd: f.cwd, env: { ...f.env, CRYKIT_VERIFICATION_FIXTURE: events }, report: () => {} }), /check:deterministic:base failed/)
  assert.equal(readFileSync(join(events, 'prepare'), 'utf8'), 'Started')
  assert.equal(readFileSync(join(events, 'checks'), 'utf8'), 'Started')
  for (const stage of ['vitest', 'browser', 'accounts']) assert.throws(() => readFileSync(join(events, stage)), { code: 'ENOENT' })
  assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
})

test('dirty development verification runs both suites without authorizing publication', async t => {
  const f = fixture(t)
  writeFileSync(join(f.cwd, 'untracked.txt'), 'Uncommitted source\n')
  const commands = []
  const result = await verifyIntegration({ ...f.options, run: async command => { commands.push(command) } })
  assert.equal(result.recorded, false)
  assert.deepEqual(commands, VERIFICATION_COMMANDS)
  f.git(['add', 'untracked.txt'])
  f.git(['commit', '--quiet', '-m', 'New source', '--', 'untracked.txt'])
  assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
})

test('source mutation and a changed committed tree during verification create no success', async t => {
  const f = fixture(t)
  await assert.rejects(verifyIntegration({ ...f.options, run: async command => {
    if (command === 'check:deterministic:base') {
      writeFileSync(join(f.cwd, 'fixture.txt'), 'Source changed while checking\n')
      f.git(['add', 'fixture.txt'])
      f.git(['commit', '--quiet', '-m', 'Changed during verification', '--', 'fixture.txt'])
    }
  } }), /Source changed/)
  assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
})

test('publication checks actual pushed trees across worktrees and every ref in a push', async t => {
  const f = fixture(t)
  const main = f.git(['rev-parse', 'HEAD'])
  await verifyIntegration(f.options)
  const task = join(f.directory, 'task')
  f.git(['worktree', 'add', '--quiet', '-b', 'task', task])
  writeFileSync(join(task, 'fixture.txt'), 'Task source\n')
  f.git(['add', 'fixture.txt'], task)
  f.git(['commit', '--quiet', '-m', 'Task change', '--', 'fixture.txt'], task)
  const taskHead = f.git(['rev-parse', 'HEAD'], task)
  const updates = f.input(main) + f.input(taskHead, 'task')
  assert.throws(() => checkPushVerification(updates, f.options), /refs\/heads\/task: full verification/)
  await verifyIntegration({ ...f.options, cwd: task })
  checkPushVerification(updates, f.options)
})

test('malformed, wrong runtime, incomplete, and wrong-version records are rejected', async t => {
  const f = fixture(t)
  await verifyIntegration(f.options)
  const path = verificationRecordPath(verificationContext(f.cwd, f.env))
  const valid = JSON.parse(readFileSync(path, 'utf8'))
  for (const record of [
    '{',
    JSON.stringify({ ...valid, version: valid.version + 1 }),
    JSON.stringify({ ...valid, runtime: { ...valid.runtime, node: 'different' } }),
    JSON.stringify({ ...valid, commands: ['check'] }),
    JSON.stringify({ ...valid, commands: ['check', 'test:e2e'] }),
    JSON.stringify({ ...valid, completedAt: 'invalid' }),
    JSON.stringify({ ...valid, tree: ZERO_OID }),
  ]) {
    writeFileSync(path, record)
    assert.throws(() => checkPushVerification(f.input(), f.options), /missing or stale/)
  }
})

test('empty input and deletion need no verification; malformed updates fail closed', t => {
  const f = fixture(t)
  checkPushVerification('', f.options)
  checkPushVerification(`(delete) ${ZERO_OID} refs/heads/old ${f.git(['rev-parse', 'HEAD'])}\n`, f.options)
  for (const input of ['garbage', 'HEAD --help refs/heads/main ' + ZERO_OID, `HEAD ${ZERO_OID} refs/heads/main invalid`]) {
    assert.throws(() => checkPushVerification(input, f.options), /Invalid pre-push/)
  }
})

test('verification records cannot authorize a different repository', async t => {
  const first = fixture(t)
  const second = fixture(t)
  second.env.XDG_CACHE_HOME = first.env.XDG_CACHE_HOME
  await verifyIntegration(first.options)
  assert.equal(first.git(['rev-parse', 'HEAD^{tree}']), second.git(['rev-parse', 'HEAD^{tree}']))
  assert.throws(() => checkPushVerification(second.input(), second.options), /missing or stale/)
})

test('CLI documents both modes and rejects filtering, positional arguments, and missing Git', t => {
  const f = fixture(t)
  for (const script of ['verify-integration.mjs', 'check-push-verification.mjs']) {
    const cli = (args, env = f.env) => execFileSync(process.execPath, [scriptPath(script), ...args], { cwd: f.cwd, env, input: '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
    for (const flag of ['-h', '--help']) assert.match(cli([flag]), /Usage:/)
    for (const args of [['--grep', 'summons'], ['--help='], ['--', 'summons.spec.ts']]) assert.throws(() => cli(args), error => error.status === 2 && error.stdout === '')
    if (script === 'verify-integration.mjs') assert.throws(() => cli([], { ...f.env, PATH: '' }), error => error.status === 3 && /Git is required/.test(error.stderr))
    else assert.equal(cli(['--']), '')
  }
})

test('the actual pre-push hook blocks an unverified tree and permits a verified local publication', async t => {
  const f = fixture(t)
  mkdirSync(join(f.cwd, 'scripts'))
  mkdirSync(join(f.cwd, '.githooks'))
  mkdirSync(join(f.cwd, 'e2e'))
  const files = ['integration-verification.mjs', 'check-push-verification.mjs', 'check-e2e-contracts.mjs']
  for (const name of files) copyFileSync(scriptPath(name), join(f.cwd, 'scripts', name))
  writeFileSync(join(f.cwd, 'scripts/privacy-check.mjs'), '// Synthetic privacy check\n')
  copyFileSync(fileURLToPath(new URL('../.githooks/pre-push', import.meta.url)), join(f.cwd, '.githooks/pre-push'))
  chmodSync(join(f.cwd, '.githooks/pre-push'), 0o755)
  writeFileSync(join(f.cwd, 'e2e/feature.spec.ts'), "const path = referencePath('base:monster:1')\n")
  const paths = [...files.map(name => `scripts/${name}`), 'scripts/privacy-check.mjs', '.githooks/pre-push', 'e2e/feature.spec.ts']
  f.git(['add', ...paths])
  f.git(['commit', '--quiet', '-m', 'Install publication hook', '--', ...paths])
  f.git(['config', 'core.hooksPath', '.githooks'])
  const remote = join(f.directory, 'remote.git')
  f.git(['init', '--bare', '--quiet', remote])
  f.git(['remote', 'add', 'origin', remote])
  assert.throws(() => f.git(['push', 'origin', 'HEAD:refs/heads/main']), error => /missing or stale/.test(error.stderr))
  assert.equal(f.git(['ls-remote', '--heads', 'origin']), '')
  await verifyIntegration(f.options)
  f.git(['push', 'origin', 'HEAD:refs/heads/main'])
  assert.match(f.git(['ls-remote', '--heads', 'origin']), new RegExp(f.git(['rev-parse', 'HEAD'])))
})
