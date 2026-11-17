import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VerificationError } from './verification-error.mjs'

const VITEST_CLI = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
// Miniflare closes dispatched connections; separate loopback families reduce source-address allocation contention
// Keep rejection-path transport behavior and a bounded number of isolated native processes
const NATIVE_SHARDS = 4
const DEFAULT_NATIVE_CONCURRENCY = 2
const NATIVE_CONCURRENCY_ENV = 'CRYKIT_NATIVE_TEST_CONCURRENCY'
const NATIVE_LOOPBACK_FAMILIES = Object.freeze(['ipv4', 'ipv6'])
const LANES = Object.freeze([
  { name: 'node', projects: ['unit', 'dom', 'persistence'] },
  // A failing serial shard can bail after cleanup without aborting another active database case
  ...Array.from({ length: NATIVE_SHARDS }, (_, index) => ({ name: `native-${index + 1}`, projects: ['worker', 'persistence-service'], workers: 1, bail: 1, shard: `${index + 1}/${NATIVE_SHARDS}`, loopback: NATIVE_LOOPBACK_FAMILIES[index % NATIVE_LOOPBACK_FAMILIES.length] })),
])

export function nativeTestConcurrency(env = process.env) {
  const value = env[NATIVE_CONCURRENCY_ENV]
  if (value !== undefined && value !== '1' && value !== '2') throw new VerificationError(`${NATIVE_CONCURRENCY_ENV} must be 1 or 2`, 2)
  // CI owns a different unfiltered schedule; never silently ignore a requested local resource bound
  if (env.CI && value !== undefined) throw new VerificationError(`${NATIVE_CONCURRENCY_ENV} is only supported without CI`, 2)
  return value === undefined ? DEFAULT_NATIVE_CONCURRENCY : Number(value)
}

async function configuredProjects({ cwd, configFile }) {
  const { loadConfigFromFile } = await import('vite')
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'test' }, configFile, cwd)
  return loaded?.config.test?.projects?.map(project => project?.test?.name) ?? []
}

async function runVitest(args, { cwd, env, label, report }) {
  const started = performance.now()
  report(`[vitest] ${label} started`)
  try {
    await new Promise((resolveRun, reject) => {
      const child = spawn(process.execPath, [VITEST_CLI, ...args], { cwd, env, stdio: 'inherit' })
      child.once('error', error => reject(new VerificationError(`Unable to start Vitest ${label}: ${error.code ?? 'spawn failed'}`, error.code === 'ENOENT' ? 3 : 1)))
      child.once('close', (code, signal) => code === 0 ? resolveRun() : reject(new VerificationError(`Vitest ${label} failed${signal ? ` (${signal})` : ''}`, code || 1)))
    })
  } catch (error) {
    report(`[vitest] ${label} failed after ${((performance.now() - started) / 1000).toFixed(3)}s`)
    throw error
  }
  report(`[vitest] ${label} passed in ${((performance.now() - started) / 1000).toFixed(3)}s`)
}

export async function verifyVitest({ cwd = process.cwd(), env = process.env, run = runVitest, readProjects = configuredProjects, report = message => process.stderr.write(message + '\n') } = {}) {
  const nativeConcurrency = nativeTestConcurrency(env)
  if (!existsSync(VITEST_CLI)) throw new VerificationError('Vitest is required; run npm ci first', 3)
  const output = resolve(cwd, '.account-tests'), configFile = resolve(cwd, 'vite.config.ts')
  mkdirSync(output, { recursive: true })
  const attempt = mkdtempSync(join(output, 'vitest-lanes-')), resultFile = join(output, 'vitest-results.json')
  const execution = env.CI ? { mode: 'ci' } : { mode: 'local', nativeConcurrency, lanes: LANES }
  writeFileSync(join(attempt, 'execution.json'), JSON.stringify(execution) + '\n')
  report(env.CI ? '[vitest] Hosted scheduling' : `[vitest] Local native concurrency=${nativeConcurrency}; shards=${NATIVE_SHARDS}; workers per shard=1`)
  // Preserve diagnostics from preceding attempts, but never leave an old successful report at the live path
  if (existsSync(resultFile)) renameSync(resultFile, join(attempt, 'previous-results.json'))
  const execute = (args, label, runEnv = env) => run(args, { cwd, env: runEnv, label, report })
  if (env.CI) {
    // Hosted runners retain their established single-process scheduling and configured worker limits
    await execute(['run', `--config=${configFile}`, '--reporter=default', '--reporter=json', `--outputFile=${resultFile}`], 'hosted suite', { ...env, CRYKIT_NATIVE_TEST_LOOPBACK: '' })
    return
  }
  const projects = await readProjects({ cwd, configFile })
  const assigned = [...new Set(LANES.flatMap(lane => lane.projects))]
  // Filters must cover the complete configured matrix; a new project requires an explicit lane assignment
  // Read and pass the same config so discovery cannot silently disagree with the executed commands
  if (projects.length !== assigned.length || new Set(projects).size !== projects.length || assigned.some(name => !projects.includes(name))) throw new VerificationError('The configured Vitest projects do not match the prepared lane assignments')
  const blobs = join(attempt, 'blobs')
  mkdirSync(blobs)
  const runLane = async lane => {
    const args = ['run', `--config=${configFile}`, ...lane.projects.map(name => `--project=${name}`)]
    if (lane.workers) args.push(`--maxWorkers=${lane.workers}`)
    if (lane.shard) args.push(`--shard=${lane.shard}`)
    // Serial shards stop after a failed case without aborting another shard's active body
    if (lane.bail) args.push(`--bail=${lane.bail}`)
    args.push('--reporter=default', '--reporter=blob', `--outputFile.blob=${join(blobs, `${lane.name}.json`)}`)
    await execute(args, `${lane.name} lane`, { ...env, CRYKIT_NATIVE_TEST_PARTITION: lane.shard ? 'balanced' : '', CRYKIT_NATIVE_TEST_LOOPBACK: lane.loopback ?? '' })
  }
  // Complete source snapshots make Node validation expensive enough to compete with native sync deadlines
  // Preserve every case and deadline while separating Node work and bounding simultaneous native backends
  await runLane(LANES[0])
  const results = []
  const nativeLanes = LANES.slice(1)
  for (let index = 0; index < nativeLanes.length; index += nativeConcurrency) {
    // The resource bound changes batching only, never membership, deadlines, or failure cleanup
    // Drain the whole batch after a failure before starting another backend or merging its evidence
    results.push(...await Promise.allSettled(nativeLanes.slice(index, index + nativeConcurrency).map(runLane)))
  }
  // A failure never cancels its sibling's active case or releases ownership before database cleanup
  // Merge failing reports too when available, retaining every result without authorizing publication
  const failed = results.find(result => result.status === 'rejected')
  const completeReports = LANES.every(lane => existsSync(join(blobs, `${lane.name}.json`)))
  let mergeFailure
  if (completeReports) {
    try { await execute([`--config=${configFile}`, `--merge-reports=${blobs}`, '--reporter=default', '--reporter=json', `--outputFile=${resultFile}`], 'combined report') }
    catch (error) { mergeFailure = error }
  }
  if (failed) throw failed.reason
  if (!completeReports) throw new VerificationError('A required Vitest lane report is missing', 1)
  if (mergeFailure) throw mergeFailure
}
