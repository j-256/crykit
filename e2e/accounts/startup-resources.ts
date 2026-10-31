import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const INTERVAL_MS = 500
const MAX_SAMPLES = 120
const MAX_PROCESSES = 32
const MAX_INVENTORY = 1024
const READ_BATCH = 16
const COUNTER_UNIT_TIMEOUT_MS = 1000
const STAT_FIELD = Object.freeze({ parent: 1, userTicks: 11, systemTicks: 12, started: 19 })
const decimal = (value: string | undefined) => value !== undefined && /^\d{1,24}$/.test(value) ? value : undefined
function stat(value: string) {
  // comm can contain spaces and parentheses; fields begin after its final closing parenthesis
  const end = value.lastIndexOf(')'), fields = value.slice(end + 2).trim().split(/\s+/)
  const pid = value.slice(0, value.indexOf(' ')), parent = fields[STAT_FIELD.parent], started = fields[STAT_FIELD.started]
  if (end < 0 || !decimal(pid) || !decimal(parent) || !decimal(started)) throw new Error('Invalid process identity')
  const name = value.slice(value.indexOf('(') + 1, end)
  const role = /^(Web Content|Isolated Web Co)/.test(name) ? 'browser-content' : /^firefox/.test(name) ? 'browser' : name === 'node' ? 'driver' : name === 'workerd' ? 'worker-runtime' : 'other'
  return { pid: Number(pid), parent: Number(parent), started, role, userTicks: decimal(fields[STAT_FIELD.userTicks]), systemTicks: decimal(fields[STAT_FIELD.systemTicks]) }
}

export async function captureStartupResources(rootPid = process.pid, procRoot = '/proc') {
  const startedAtMilliseconds = Date.now(), began = performance.now()
  let unavailableReads = 0, invalidIdentities = 0, changedProcesses = 0
  const read = async (path: string) => { try { return await readFile(join(procRoot, path), 'utf8') } catch { unavailableReads++; return '' } }
  const names = (await readdir(procRoot)).filter(name => /^\d+$/.test(name) && Number(name) !== rootPid)
  const inventory = [String(rootPid), ...names.slice(0, MAX_INVENTORY - 1)]
  const identities = new Map<number, ReturnType<typeof stat>>()
  // One bounded process inventory avoids reading every thread merely to find child processes
  // Only descendants are retained, with fixed roles instead of arbitrary comm values
  for (let at = 0; at < inventory.length; at += READ_BATCH) {
    await Promise.all(inventory.slice(at, at + READ_BATCH).map(async name => {
      try { const value = stat(await read(`${name}/stat`)); if (value.pid === Number(name)) identities.set(value.pid, value); else invalidIdentities++ } catch { invalidIdentities++ }
    }))
  }
  const owned = new Set<number>(identities.has(rootPid) ? [rootPid] : [])
  for (let size = 0; size !== owned.size;) {
    size = owned.size
    for (const value of identities.values()) if (owned.has(value.parent)) owned.add(value.pid)
  }
  const processes = []
  for (const pid of [...owned].slice(0, MAX_PROCESSES)) {
    const identity = identities.get(pid)
    if (!identity) continue
    const [status, io, scheduling, after] = await Promise.all([read(`${pid}/status`), read(`${pid}/io`), read(`${pid}/schedstat`), read(`${pid}/stat`)])
    // A vanished or reused PID must not join two different process lifetimes
    try { const current = stat(after); if (current.started !== identity.started || current.parent !== identity.parent) { changedProcesses++; continue } } catch { changedProcesses++; continue }
    const [runtimeNanoseconds, runqueueNanoseconds, timeslices] = scheduling.trim().split(/\s+/).map(decimal)
    // Main-thread schedstat separates execution from runnable time awaiting a CPU
    // Process stat totals include other threads, whose individual runqueue waits are not captured
    // https://www.kernel.org/doc/html/latest/scheduler/sched-stats.html
    const mainThread = { runtimeNanoseconds, runqueueNanoseconds, timeslices }
    const ioCounters = Object.fromEntries(['rchar', 'wchar', 'read_bytes', 'write_bytes'].map(key => [key, decimal(io.match(new RegExp(`^${key}: (\\d+)$`, 'm'))?.[1])]))
    processes.push({ ...identity, residentKiB: decimal(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1]), io: ioCounters, mainThread })
  }
  const [scheduler, memory, cpuPressure, memoryPressure, ioPressure] = await Promise.all(['sys/kernel/sched_schedstats', 'meminfo', 'pressure/cpu', 'pressure/memory', 'pressure/io'].map(read))
  const pressure = (value: string) => decimal(value.match(/^some .*\btotal=(\d+)$/m)?.[1])
  return { startedAtMilliseconds, collectionMilliseconds: performance.now() - began, unavailableReads, invalidIdentities, changedProcesses, inventoryTruncated: names.length + 1 > MAX_INVENTORY, processesTruncated: owned.size > MAX_PROCESSES, schedStatsEnabled: scheduler.trim() === '1' ? true : scheduler.trim() === '0' ? false : null, availableMemoryKiB: decimal(memory.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]), pressureMicroseconds: { cpu: pressure(cpuPressure), memory: pressure(memoryPressure), io: pressure(ioPressure) }, processes }
}

export function startStartupResources({ enabled = process.platform === 'linux', rootPid = process.pid, procRoot = '/proc' } = {}) {
  const samples: Awaited<ReturnType<typeof captureStartupResources>>[] = []
  let stopped = false, failedCaptures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> = Promise.resolve()
  const sample = () => {
    pending = captureStartupResources(rootPid, procRoot).then(value => {
      samples.push(value)
      if (samples.length > MAX_SAMPLES) samples.shift()
    }, () => { failedCaptures++ }).finally(() => {
      // Do not overlap scans or leave diagnostics running after the owning journey
      if (!stopped) { timer = setTimeout(sample, INTERVAL_MS); timer.unref() }
    })
  }
  const clockTicks = enabled ? promisify(execFile)('getconf', ['CLK_TCK'], { timeout: COUNTER_UNIT_TIMEOUT_MS }).then(({ stdout }) => decimal(stdout.trim()), () => undefined) : Promise.resolve(undefined)
  if (enabled) sample()
  return async () => {
    stopped = true
    clearTimeout(timer)
    await pending
    return { supported: enabled, intervalMilliseconds: INTERVAL_MS, retainedSampleLimit: MAX_SAMPLES, failedCaptures, clockTicksPerSecond: await clockTicks, samples }
  }
}
