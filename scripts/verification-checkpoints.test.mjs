import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as checkpoints from './verification-checkpoints.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'verification-checkpoints-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const options = { directory, identity: 'exact-input', report: () => {} }
  return { directory, options }
}

test('resumption retains successes and failure artifacts, rerunning only unfinished steps', async t => {
  const f = fixture(t)
  assert.equal(typeof checkpoints.createCheckpointSession, 'function')
  const first = checkpoints.createCheckpointSession(f.options)
  const validate = dir => assert.equal(readFileSync(join(dir, 'report'), 'utf8'), 'passed')
  let executed = 0
  const pass = dir => { executed++; writeFileSync(join(dir, 'report'), 'passed') }
  await first.run('checks', pass, validate)
  let failedDirectory
  await assert.rejects(first.run('browser-1', dir => { failedDirectory = dir; writeFileSync(join(dir, 'report'), 'failed'); throw new Error('fixture failed') }, validate), /fixture failed/)
  first.close()
  const second = checkpoints.createCheckpointSession({ ...f.options, resume: true })
  await second.run('checks', pass, validate)
  await second.run('browser-1', pass, validate)
  assert.equal(executed, 2)
  assert.equal(readFileSync(join(failedDirectory, 'report'), 'utf8'), 'failed')
  assert.deepEqual(second.summary(), { reused: ['checks'], executed: ['browser-1'], recovered: ['browser-1'] })
  second.close()
})

test('fresh attempts and different identities cannot reuse checkpoints', async t => {
  const f = fixture(t)
  let count = 0
  for (const options of [f.options, f.options, { ...f.options, identity: 'changed', resume: true }]) {
    const session = checkpoints.createCheckpointSession(options)
    await session.run('step', () => { count++ })
    session.close()
  }
  assert.equal(count, 3)
})

test('corrupt saved evidence is rerun and a successful exit without valid evidence cannot pass', async t => {
  const f = fixture(t)
  let path
  const validate = dir => assert.equal(readFileSync(join(dir, 'report'), 'utf8'), 'passed')
  const first = checkpoints.createCheckpointSession(f.options)
  await first.run('step', dir => { path = join(dir, 'report'); writeFileSync(path, 'passed') }, validate)
  first.close()
  writeFileSync(path, 'corrupt')
  const second = checkpoints.createCheckpointSession({ ...f.options, resume: true })
  await assert.rejects(second.run('step', () => {}, validate), /ENOENT/)
  assert.deepEqual(second.summary().reused, [])
  second.close()
})

test('concurrent owners cannot replace a campaign; source checks prevent checkpoint acceptance', async t => {
  const f = fixture(t)
  let current = true
  const session = checkpoints.createCheckpointSession({ ...f.options, assertCurrent: () => { if (!current) throw new Error('source changed') } })
  assert.throws(() => checkpoints.createCheckpointSession(f.options), /already active/)
  await assert.rejects(session.run('step', () => { current = false }), /source changed/)
  session.close()
  const next = checkpoints.createCheckpointSession({ ...f.options, resume: true })
  let executed = false
  await next.run('step', () => { executed = true })
  assert.equal(executed, true)
  next.close()
})

test('concurrent siblings preserve both checkpoints and an unfinished step is never reused', async t => {
  const f = fixture(t)
  const session = checkpoints.createCheckpointSession(f.options)
  await Promise.all(['guest', 'accounts'].map(id => session.run(id, async () => { await new Promise(resolve => setImmediate(resolve)) })))
  session.close()
  const next = checkpoints.createCheckpointSession({ ...f.options, resume: true })
  await Promise.all(['guest', 'accounts'].map(id => next.run(id, () => assert.fail('reused step executed'))))
  assert.deepEqual(next.summary().reused.sort(), ['accounts', 'guest'])
  next.close()
})

test('content fingerprints ignore timestamps but detect bytes, filenames, and symlink targets', t => {
  const f = fixture(t)
  assert.equal(typeof checkpoints.fingerprintPaths, 'function')
  writeFileSync(join(f.directory, 'file'), 'a')
  const first = checkpoints.fingerprintPaths(f.directory, ['file'])
  writeFileSync(join(f.directory, 'file'), 'a')
  assert.equal(checkpoints.fingerprintPaths(f.directory, ['file']), first)
  writeFileSync(join(f.directory, 'file'), 'b')
  assert.notEqual(checkpoints.fingerprintPaths(f.directory, ['file']), first)
  assert.throws(() => checkpoints.fingerprintPaths(f.directory, ['missing']), /ENOENT/)
})

test('linked input fingerprints include target contents', async t => {
  const f = fixture(t)
  writeFileSync(join(f.directory, 'target'), 'first')
  symlinkSync(join(f.directory, 'target'), join(f.directory, 'link'))
  const first = checkpoints.fingerprintPaths(f.directory, ['link'])
  writeFileSync(join(f.directory, 'target'), 'second')
  assert.notEqual(checkpoints.fingerprintPaths(f.directory, ['link']), first)
})

test('an exited process leaves unfinished work for an explicit resume', async t => {
  const f = fixture(t)
  const module = fileURLToPath(new URL('./verification-checkpoints.mjs', import.meta.url))
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createCheckpointSession } from ${JSON.stringify(module)}
    const session = createCheckpointSession(${JSON.stringify(f.options)})
    await session.run('first', () => {})
    session.run('interrupted', () => process.exit(0))
  `])
  const session = checkpoints.createCheckpointSession({ ...f.options, resume: true })
  await session.run('first', () => assert.fail('completed work reran'))
  let executed = false
  await session.run('interrupted', () => { executed = true })
  assert.equal(executed, true)
  assert.deepEqual(session.summary().recovered, ['interrupted'])
  session.close()
})

test('fresh campaigns retain the preceding failure history alongside its artifacts', async t => {
  const f = fixture(t)
  const first = checkpoints.createCheckpointSession(f.options)
  await assert.rejects(first.run('step', () => { throw new Error('retained failure') }), /retained failure/)
  const campaign = first.campaign
  first.close()
  const next = checkpoints.createCheckpointSession(f.options)
  await next.run('step', () => {})
  next.close()
  const archived = JSON.parse(readFileSync(join(f.directory, campaign, 'campaign.json'), 'utf8'))
  assert.equal(archived.steps[0].error, 'retained failure')
})

test('structurally corrupt checkpoint records are discarded instead of blocking recovery', async t => {
  const f = fixture(t)
  const session = checkpoints.createCheckpointSession(f.options)
  await session.run('step', () => {})
  session.close()
  const path = join(f.directory, `${checkpoints.digest(f.options.identity)}.json`)
  const valid = JSON.parse(readFileSync(path, 'utf8'))
  for (const corrupt of [{ ...valid, campaign: null }, { ...valid, steps: [null] }, { ...valid, steps: [{ id: 'step', status: 'passed' }] }]) {
    writeFileSync(path, JSON.stringify(corrupt))
    const resumed = checkpoints.createCheckpointSession({ ...f.options, resume: true })
    let ran = false
    try { await resumed.run('step', () => { ran = true }); assert.equal(ran, true) }
    finally { resumed.close() }
  }
})

test('invalidation cannot overwrite a replacement checkpoint owner', async t => {
  const f = fixture(t)
  const session = checkpoints.createCheckpointSession(f.options)
  await session.run('step', () => {})
  writeFileSync(join(f.directory, 'active.json'), JSON.stringify({ pid: process.pid, attempt: 'replacement' }))
  const path = join(f.directory, `${checkpoints.digest(f.options.identity)}.json`)
  writeFileSync(path, JSON.stringify({ replacement: true }))
  assert.throws(() => session.invalidate('lost ownership'), /owner/)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { replacement: true })
  session.close()
})
