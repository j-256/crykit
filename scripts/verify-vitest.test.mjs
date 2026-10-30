import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyVitest } from './vitest-verification.mjs'

const PROJECTS = ['unit', 'dom', 'persistence', 'worker', 'persistence-service']
const turn = () => new Promise(resolve => setImmediate(resolve))
const scriptPath = name => fileURLToPath(new URL(name, import.meta.url))
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'crykit-vitest-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const env = { ...process.env }
  delete env.CI
  return { cwd, env, readProjects: async () => PROJECTS }
}
function lane(args) { return args.includes('--project=worker') ? 'native' : args.some(arg => arg.startsWith('--merge-reports=')) ? 'merge' : 'node' }
function blob(args) {
  const path = args.find(arg => arg.startsWith('--outputFile.blob='))?.slice('--outputFile.blob='.length)
  if (path) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, 'synthetic blob') }
}

test('prepared Node and native lanes overlap and merging waits for both', async t => {
  const f = fixture(t), node = Promise.withResolvers(), native = Promise.withResolvers()
  const calls = []
  const pending = verifyVitest({ ...f, run: async (args, options) => {
    const name = lane(args); calls.push({ name, args, env: options.env }); blob(args)
    if (name === 'node') await node.promise
    if (name === 'native') await native.promise
  } })
  try {
    await turn()
    assert.deepEqual(calls.map(call => call.name), ['node', 'native', 'native', 'native'])
    assert.deepEqual(calls.slice(1).map(call => call.args.find(arg => arg.startsWith('--shard='))), ['--shard=1/3', '--shard=2/3', '--shard=3/3'])
    assert.ok(calls.slice(1).every(call => call.args.includes('--maxWorkers=1') && call.args.includes('--bail=1')))
    assert.ok(calls.slice(1).every(call => call.env.CRYKIT_NATIVE_TEST_PARTITION === 'balanced'))
    assert.equal(calls[0].env.CRYKIT_NATIVE_TEST_PARTITION, '')
    assert.equal(calls[0].args.some(arg => arg.startsWith('--bail=')), false)
    assert.deepEqual([...new Set(calls.flatMap(call => call.args.filter(arg => arg.startsWith('--project=')).map(arg => arg.slice('--project='.length))))].sort(), [...PROJECTS].sort())
    node.resolve(); await turn()
    assert.equal(calls.length, 4)
  } finally { node.resolve(); native.resolve(); await pending }
  assert.deepEqual(calls.map(call => call.name), ['node', 'native', 'native', 'native', 'merge'])
})

test('a native failure drains every remaining native peer before merging reports', async t => {
  const f = fixture(t), second = Promise.withResolvers(), third = Promise.withResolvers()
  const cleaned = [], calls = []
  let settled = false
  const pending = verifyVitest({ ...f, run: async args => {
    calls.push(lane(args)); blob(args)
    if (args.includes('--shard=1/3')) throw new Error('Synthetic first-shard failure')
    if (args.includes('--shard=2/3')) { await second.promise; cleaned.push('second') }
    if (args.includes('--shard=3/3')) { await third.promise; cleaned.push('third') }
  } })
  const outcome = pending.then(() => { settled = true; return undefined }, error => { settled = true; return error })
  try {
    await turn(); assert.equal(settled, false)
    second.resolve(); await turn()
    assert.deepEqual(cleaned, ['second'])
    assert.equal(settled, false)
    assert.equal(calls.includes('merge'), false)
  } finally { second.resolve(); third.resolve() }
  assert.match((await outcome)?.message ?? '', /Synthetic first-shard failure/)
  assert.deepEqual(cleaned, ['second', 'third'])
  assert.equal(calls.at(-1), 'merge')
})

test('a failed lane drains its active sibling and cannot report success', async t => {
  const f = fixture(t), release = Promise.withResolvers()
  let settled = false, cleaned = false
  const pending = verifyVitest({ ...f, run: async args => {
    blob(args)
    if (lane(args) === 'native') throw new Error('Synthetic native failure')
    if (lane(args) === 'node') { await release.promise; cleaned = true }
  } })
  const outcome = pending.then(() => { settled = true; return undefined }, error => { settled = true; return error })
  try { await turn(); assert.equal(settled, false); assert.equal(cleaned, false) }
  finally { release.resolve() }
  assert.match((await outcome)?.message ?? '', /Synthetic native failure/)
  assert.equal(cleaned, true)
})

test('an unassigned configured project fails before any tests can be omitted', async t => {
  const f = fixture(t)
  let invoked = false
  await assert.rejects(verifyVitest({ ...f, readProjects: async () => [...PROJECTS, 'future-project'], run: async () => { invoked = true } }), /project/i)
  assert.equal(invoked, false)
})

test('report merging failure cannot turn successful lanes into success', async t => {
  const f = fixture(t)
  await assert.rejects(verifyVitest({ ...f, run: async args => {
    blob(args)
    if (lane(args) === 'merge') throw new Error('Synthetic merge failure')
  } }), /Synthetic merge failure/)
})

test('a successful exit without every lane report cannot publish stale results', async t => {
  const f = fixture(t), output = join(f.cwd, '.account-tests/vitest-results.json')
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, 'old successful result')
  await assert.rejects(verifyVitest({ ...f, run: async () => { assert.equal(existsSync(output), false) } }), /report/i)
})

test('hosted runs retain one unfiltered Vitest invocation', async t => {
  const f = fixture(t), calls = []
  await verifyVitest({ ...f, env: { ...f.env, CI: '1' }, run: async args => calls.push(args) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].some(arg => arg.startsWith('--project=')), false)
  assert.equal(calls[0].some(arg => arg.startsWith('--sequence.sequencer=')), false)
})

function realFixture(t, bodies) {
  const f = fixture(t)
  delete f.readProjects
  writeFileSync(join(f.cwd, 'package.json'), JSON.stringify({ type: 'module' }))
  // Tiny runner fixtures deliberately leave some shards empty; the repository gate keeps its no-tests guard
  writeFileSync(join(f.cwd, 'vite.config.ts'), `import NativeTestSequencer from ${JSON.stringify(scriptPath('native-test-sequencer.ts'))}; export default { test: { sequence: process.env.CRYKIT_NATIVE_TEST_PARTITION === 'balanced' ? { sequencer: NativeTestSequencer } : undefined, maxWorkers: 1, passWithNoTests: true, projects: ${JSON.stringify(PROJECTS.map(name => ({ test: { name, include: name === 'unit' ? ['node.test.mjs'] : name === 'worker' ? ['native*.test.mjs'] : [] } })))} } }`)
  const entry = pathToFileURL(scriptPath('../node_modules/vitest/dist/index.js')).href
  for (const [name, body] of Object.entries(bodies)) writeFileSync(join(f.cwd, `${name}.test.mjs`), `import { test, expect, afterEach } from ${JSON.stringify(entry)};\n${body}\n`)
  return f
}

test('real pinned Vitest lanes merge every executed case without running them again', async t => {
  const f = realFixture(t, {
    node: `import { appendFileSync } from 'node:fs'; test('node case', () => { appendFileSync('executed.txt', 'node\\n'); expect(1).toBe(1) })`,
    native: `import { appendFileSync } from 'node:fs'; test('native case', () => { appendFileSync('executed.txt', 'native\\n'); expect(2).toBe(2) }); test('later native case', () => { appendFileSync('executed.txt', 'native-later\\n'); expect(3).toBe(3) })`,
    'native-peer': `import { appendFileSync } from 'node:fs'; test('independent native case', () => { appendFileSync('executed.txt', 'native-peer\\n'); expect(4).toBe(4) })`,
  })
  await verifyVitest({ ...f, report: () => {} })
  const report = JSON.parse(readFileSync(join(f.cwd, '.account-tests/vitest-results.json'), 'utf8'))
  assert.equal(report.numPassedTests, 4)
  assert.equal(report.numFailedTests, 0)
  assert.deepEqual(readFileSync(join(f.cwd, 'executed.txt'), 'utf8').trim().split('\n').sort(), ['native', 'native-later', 'native-peer', 'node'])
})

test('a native failure finishes asynchronous transaction cleanup before stopping later cases', async t => {
  const f = realFixture(t, {
    node: `test('node case', () => expect(1).toBe(1))`,
    native: `import { DatabaseSync } from 'node:sqlite'; import { writeFileSync } from 'node:fs';
const db = new DatabaseSync('retained.sqlite'); db.exec('CREATE TABLE records (value TEXT)');
afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  db.exec('COMMIT'); db.close(); writeFileSync('cleaned', 'yes');
});
test('fails inside its transaction', () => {
  db.exec('BEGIN'); db.exec("INSERT INTO records VALUES ('kept')"); expect('actual').toBe('expected');
});
test('later native case must not start', () => { writeFileSync('unexpected', 'yes') });`,
  })
  const sqliteFlags = process.allowedNodeEnvironmentFlags.has('--experimental-sqlite') ? ['--experimental-sqlite'] : []
  f.env.NODE_OPTIONS = [f.env.NODE_OPTIONS, ...sqliteFlags].filter(Boolean).join(' ')
  await assert.rejects(verifyVitest({ ...f, report: () => {} }), /native-\d+ lane failed/)
  assert.equal(readFileSync(join(f.cwd, 'cleaned'), 'utf8'), 'yes')
  assert.equal(existsSync(join(f.cwd, 'unexpected')), false)
  const count = execFileSync(process.execPath, [...sqliteFlags, '--input-type=module', '-e', "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('retained.sqlite'); console.log(db.prepare('SELECT COUNT(*) AS count FROM records').get().count); db.close()"], { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  assert.equal(count, '1')
  const report = JSON.parse(readFileSync(join(f.cwd, '.account-tests/vitest-results.json'), 'utf8'))
  assert.equal(report.numFailedTests, 1)
  assert.equal(report.numPassedTests, 1)
})

test('a real failed lane waits for its sibling transaction commit and cleanup', async t => {
  const f = realFixture(t, {
    node: `import { existsSync } from 'node:fs'; test('fails after the sibling enters its transaction', async () => { while (!existsSync('entered')) await new Promise(resolve => setTimeout(resolve, 2)); expect('actual').toBe('expected') })`,
    native: `import { DatabaseSync } from 'node:sqlite'; import { existsSync, writeFileSync } from 'node:fs';
const db = new DatabaseSync('retained.sqlite'); db.exec('CREATE TABLE records (value TEXT)');
afterEach(() => { db.close(); writeFileSync('cleaned', String(existsSync('committed'))) });
test('commits the active database transaction before cleanup', async () => {
  db.exec('BEGIN'); db.exec("INSERT INTO records VALUES ('kept')"); writeFileSync('entered', 'yes');
  while (!existsSync('release')) await new Promise(resolve => setTimeout(resolve, 2));
  db.exec('COMMIT'); writeFileSync('committed', 'yes');
})`,
  })
  // Enable the native SQLite fixture only through a flag explicitly supported by this Node runtime
  const sqliteFlags = process.allowedNodeEnvironmentFlags.has('--experimental-sqlite') ? ['--experimental-sqlite'] : []
  f.env.NODE_OPTIONS = [f.env.NODE_OPTIONS, ...sqliteFlags].filter(Boolean).join(' ')
  const pending = verifyVitest({ ...f, report: message => {
    if (message.includes('node lane failed')) {
      assert.equal(existsSync(join(f.cwd, 'cleaned')), false)
      writeFileSync(join(f.cwd, 'release'), 'yes')
    }
  } })
  await assert.rejects(pending, /node lane failed/)
  assert.equal(readFileSync(join(f.cwd, 'cleaned'), 'utf8'), 'true')
  const count = execFileSync(process.execPath, [...sqliteFlags, '--input-type=module', '-e', "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('retained.sqlite'); console.log(db.prepare('SELECT COUNT(*) AS count FROM records').get().count); db.close()"], { cwd: f.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  assert.equal(count, '1')
  assert.equal(JSON.parse(readFileSync(join(f.cwd, '.account-tests/vitest-results.json'), 'utf8')).numFailedTests, 1)
})

test('help and invalid arguments never require dependencies or start tests', t => {
  const f = fixture(t), scripts = join(f.cwd, 'scripts')
  mkdirSync(scripts)
  for (const name of ['verify-vitest.mjs', 'vitest-verification.mjs', 'integration-verification.mjs']) copyFileSync(scriptPath(name), join(scripts, name))
  for (const flag of ['-h', '--help']) {
    const result = spawnSync(process.execPath, [join(scripts, 'verify-vitest.mjs'), flag], { cwd: f.cwd, encoding: 'utf8' })
    assert.equal(result.status, 0); assert.match(result.stdout, /Usage:/); assert.equal(result.stderr, '')
  }
  for (const args of [['--unknown'], ['test-filter'], ['--', 'test-filter']]) {
    const result = spawnSync(process.execPath, [join(scripts, 'verify-vitest.mjs'), ...args], { cwd: f.cwd, encoding: 'utf8' })
    assert.equal(result.status, 2); assert.equal(result.stdout, '')
  }
  const missing = spawnSync(process.execPath, [join(scripts, 'verify-vitest.mjs')], { cwd: f.cwd, encoding: 'utf8' })
  assert.equal(missing.status, 3)
  assert.equal(existsSync(join(f.cwd, '.account-tests')), false)
})
