import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VerificationError } from './integration-verification.mjs'

const VITEST_CLI = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
// Miniflare closes each dispatched connection, so parallel fixtures share a finite ephemeral-port pool
// Keep rejection-path transport behavior while bounding socket churn across isolated native processes
const NATIVE_SHARDS = 3
const LANES = Object.freeze([
  { name: 'node', projects: ['unit', 'dom', 'persistence'] },
  // A failing serial shard can bail after cleanup without aborting another active database case
  ...Array.from({ length: NATIVE_SHARDS }, (_, index) => ({ name: `native-${index + 1}`, projects: ['worker', 'persistence-service'], workers: 1, bail: 1, shard: `${index + 1}/${NATIVE_SHARDS}` })),
])

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
  if (!existsSync(VITEST_CLI)) throw new VerificationError('Vitest is required; run npm ci first', 3)
  const output = resolve(cwd, '.account-tests'), configFile = resolve(cwd, 'vite.config.ts')
  mkdirSync(output, { recursive: true })
  const attempt = mkdtempSync(join(output, 'vitest-lanes-')), resultFile = join(output, 'vitest-results.json')
  // Preserve diagnostics from preceding attempts, but never leave an old successful report at the live path
  if (existsSync(resultFile)) renameSync(resultFile, join(attempt, 'previous-results.json'))
  const execute = (args, label, runEnv = env) => run(args, { cwd, env: runEnv, label, report })
  if (env.CI) {
    // Hosted runners retain their established single-process scheduling and configured worker limits
    await execute(['run', `--config=${configFile}`, '--reporter=default', '--reporter=json', `--outputFile=${resultFile}`], 'hosted suite')
    return
  }
  const projects = await readProjects({ cwd, configFile })
  const assigned = [...new Set(LANES.flatMap(lane => lane.projects))]
  // Filters must cover the complete configured matrix; a new project requires an explicit lane assignment
  // Read and pass the same config so discovery cannot silently disagree with the executed commands
  if (projects.length !== assigned.length || new Set(projects).size !== projects.length || assigned.some(name => !projects.includes(name))) throw new VerificationError('The configured Vitest projects do not match the prepared lane assignments')
  const blobs = join(attempt, 'blobs')
  mkdirSync(blobs)
  const results = await Promise.allSettled(LANES.map(lane => (async () => {
    const args = ['run', `--config=${configFile}`, ...lane.projects.map(name => `--project=${name}`)]
    if (lane.workers) args.push(`--maxWorkers=${lane.workers}`)
    if (lane.shard) args.push(`--shard=${lane.shard}`)
    // Serial shards stop after a failed case without aborting another shard's active body
    if (lane.bail) args.push(`--bail=${lane.bail}`)
    args.push('--reporter=default', '--reporter=blob', `--outputFile.blob=${join(blobs, `${lane.name}.json`)}`)
    await execute(args, `${lane.name} lane`, { ...env, CRYKIT_NATIVE_TEST_PARTITION: lane.shard ? 'balanced' : '' })
  })()))
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
