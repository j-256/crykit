import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureStartupResources, startStartupResources } from '../e2e/accounts/startup-resources.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'startup-resources-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const write = async (path, value) => { const target = join(root, path); await mkdir(join(target, '..'), { recursive: true }); await writeFile(target, value) }
  const process = async (pid, parent, name) => {
    const fields = Array(22).fill('0'); fields[0] = 'S'; fields[1] = String(parent); fields[11] = '12'; fields[12] = '3'; fields[19] = '456'
    await write(`${pid}/stat`, `${pid} (${name}) ${fields.join(' ')}`)
    await write(`${pid}/schedstat`, '1000000 500000 8')
    await write(`${pid}/status`, 'VmRSS:\t789 kB\nName:\tprivate-name\n')
    await write(`${pid}/io`, 'rchar: 10\nwchar: 20\nread_bytes: 30\nwrite_bytes: 40\n')
  }
  return { root, write, process }
}

test('startup resources retain owned descendants and fixed numeric fields without names or paths', async t => {
  const f = await fixture(t)
  await f.process(100, 1, 'private (name)')
  await f.process(101, 100, 'Web Content')
  await f.process(200, 999, 'unrelated-private')
  await f.write('sys/kernel/sched_schedstats', '1')
  const result = await captureStartupResources(100, f.root)
  assert.deepEqual(result.processes.map(value => value.pid), [100, 101])
  assert.equal(result.changedProcesses, 0)
  assert.equal(result.schedStatsEnabled, true)
  assert.equal(result.processes[1].role, 'browser-content')
  assert.equal(result.processes[1].residentKiB, '789')
  assert.deepEqual(result.processes[1].io, { rchar: '10', wchar: '20', read_bytes: '30', write_bytes: '40' })
  assert.equal(result.processes[1].mainThread.runqueueNanoseconds, '500000')
  assert.ok(result.unavailableReads > 0)
  assert.doesNotMatch(JSON.stringify(result), /private|startup-resources-/)
})

test('startup resource bounds report incomplete capture instead of claiming missing processes are idle', async t => {
  const f = await fixture(t)
  await f.process(100, 1, 'node')
  for (let pid = 101; pid < 141; pid++) await f.process(pid, 100, 'workerd')
  const result = await captureStartupResources(100, f.root)
  assert.equal(result.processes.length, 32)
  assert.equal(result.processesTruncated, true)
  assert.equal(result.schedStatsEnabled, null)
  await f.write('100/stat', 'invalid')
  const invalid = await captureStartupResources(100, f.root)
  assert.deepEqual(invalid.processes, [])
  assert.equal(invalid.invalidIdentities, 1)
})

test('startup sampling drains its in-flight capture and leaves no scheduled scan after stop', async t => {
  const f = await fixture(t)
  await f.process(100, 1, 'node')
  const stop = startStartupResources({ enabled: true, rootPid: 100, procRoot: f.root })
  const result = await stop()
  assert.equal(result.samples.length, 1)
  assert.equal(result.failedCaptures, 0)
  await new Promise(resolve => setTimeout(resolve, result.intervalMilliseconds + 10))
  assert.equal((await stop()).samples.length, 1)
  assert.equal((await startStartupResources({ enabled: false })()).supported, false)
})
