import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { digest, writeJson } from './verification-checkpoints.mjs'

export const BROWSER_PARTITIONS = 6
const MAX_DISCOVERY_BYTES = 32 * 1024 * 1024

function cases(report) {
  if (!report || !Array.isArray(report.suites) || !Array.isArray(report.errors) || report.errors.length) throw new Error('Playwright report is missing or contains errors')
  const result = []
  const visit = (suite, ancestors = []) => {
    const titles = [...ancestors, suite.title]
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) result.push({ spec, test, titles })
    for (const child of suite.suites ?? []) visit(child, titles)
  }
  for (const suite of report.suites) visit(suite)
  return result
}

export function playwrightManifest(report) {
  return cases(report).map(({ spec, test, titles }) => ({
    titles, file: spec.file, line: spec.line, column: spec.column, title: spec.title,
    project: test.projectName, expectedStatus: test.expectedStatus, tags: spec.tags ?? [],
    timeout: test.timeout,
  }))
}

const identities = manifest => manifest.map(item => JSON.stringify(item)).sort()
export function assertPartitionCoverage(required, partitions) {
  if (JSON.stringify(identities(required)) !== JSON.stringify(identities(partitions.flat()))) throw new Error('Playwright partition coverage differs from the complete required manifest')
}

export function validatePlaywrightReport(report, manifest) {
  // test.setTimeout inside a body is invisible to --list; the committed source owns that deadline
  // Compare discovery deadlines across shards, and retain each positive runtime deadline in receipts
  const omitTimeout = ({ timeout: _timeout, ...identity }) => identity
  assertPartitionCoverage(manifest.map(omitTimeout), [playwrightManifest(report).map(omitTimeout)])
  for (const { test } of cases(report)) {
    const skippedByDefinition = test.expectedStatus === 'skipped'
    const expected = skippedByDefinition ? 'skipped' : test.expectedStatus
    if (!Number.isFinite(test.timeout) || test.timeout <= 0 || !Array.isArray(test.results) || test.results.length !== 1 ||
      test.results[0].status !== expected || test.results[0].retry !== 0 ||
      test.status !== (skippedByDefinition ? 'skipped' : 'expected')) throw new Error(`Playwright case did not pass its required outcome in ${test.projectName}`)
  }
}

export async function runLogged(command, args, { cwd, env, log, echo = true, capture = false }) {
  if (log) mkdirSync(join(log, '..'), { recursive: true, mode: 0o700 })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let failure
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const forward = signal => child.kill(signal)
    const interrupt = () => forward('SIGINT')
    const terminate = () => forward('SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    const receive = (data, isError) => {
      if (log) appendFileSync(log, data, { mode: 0o600 })
      if (echo) (isError ? process.stderr : process.stdout).write(data)
      if (capture && !isError) {
        stdout += data.toString()
        if (Buffer.byteLength(stdout) > MAX_DISCOVERY_BYTES) { failure = new Error('Playwright discovery exceeded its output limit'); child.kill('SIGTERM') }
      }
    }
    child.stdout.on('data', data => receive(data, false))
    child.stderr.on('data', data => receive(data, true))
    child.once('error', error => { failure = error })
    child.once('close', (code, signal) => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      if (failure || code !== 0) reject(failure ?? new Error(`${command} ${args.join(' ')} failed${signal ? ` (${signal})` : ` (exit ${code})`}${log ? `; evidence: ${log}` : ''}`))
      else resolve(stdout)
    })
  })
}

function playwrightCli(cwd) {
  return createRequire(join(cwd, 'package.json')).resolve('@playwright/test/cli')
}

export async function discoverPlaywrightPhase({ cwd, env, config, partitions = BROWSER_PARTITIONS, cli = playwrightCli(cwd) }) {
  if (!Number.isInteger(partitions) || partitions < 1) throw new Error('Invalid Playwright partition count')
  const discover = async shard => {
    const output = await runLogged(process.execPath, [cli, 'test', '--config', config, '--list', '--reporter=json', ...(shard ? ['--shard', shard] : [])], {
      cwd, env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: '', PLAYWRIGHT_JSON_OUTPUT_NAME: '', PLAYWRIGHT_JSON_OUTPUT_DIR: '' }, echo: false, capture: true,
    })
    const report = JSON.parse(output)
    return { manifest: playwrightManifest(report), config: report.config }
  }
  const full = await discover()
  if (!full.manifest.length) throw new Error('The required Playwright manifest is empty')
  const parts = []
  for (let index = 1; index <= partitions; index++) {
    const shard = `${index}/${partitions}`
    parts.push({ shard, ...await discover(shard) })
  }
  assertPartitionCoverage(full.manifest, parts.map(part => part.manifest))
  return { ...full, partitions: parts }
}

export async function runPlaywrightPhase({ cwd, env, config, phase, session, id, output, echo = true, cli = playwrightCli(cwd) }) {
  assertPartitionCoverage(phase.manifest, phase.partitions.map(part => part.manifest))
  const reports = []
  for (const part of phase.partitions) {
    if (!part.manifest.length) continue
    const manifestDigest = digest(JSON.stringify(part.manifest))
    const directory = await session.run(`${id}:${part.shard}:${manifestDigest}`, async artifacts => {
      writeJson(join(artifacts, 'manifest.json'), part.manifest)
      await runLogged(process.execPath, [cli, 'test', '--config', config, '--shard', part.shard, '--reporter', env.CI ? 'list,github,json' : 'list,json', '--output', join(artifacts, 'artifacts')], {
        cwd, env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: join(artifacts, 'results.json') }, log: join(artifacts, 'run.log'), echo,
      })
    }, artifacts => {
      const saved = JSON.parse(readFileSync(join(artifacts, 'manifest.json'), 'utf8'))
      assertPartitionCoverage(part.manifest, [saved])
      validatePlaywrightReport(JSON.parse(readFileSync(join(artifacts, 'results.json'), 'utf8')), part.manifest)
    })
    reports.push(JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8')))
  }
  const aggregate = {
    ...reports[0], config: phase.config,
    suites: reports.flatMap(report => report.suites), errors: [],
    stats: { startTime: reports[0]?.stats?.startTime, duration: reports.reduce((sum, report) => sum + (report.stats?.duration ?? 0), 0),
      expected: reports.reduce((sum, report) => sum + (report.stats?.expected ?? 0), 0),
      skipped: reports.reduce((sum, report) => sum + (report.stats?.skipped ?? 0), 0), unexpected: 0, flaky: 0 },
  }
  validatePlaywrightReport(aggregate, phase.manifest)
  writeJson(output, aggregate)
}
