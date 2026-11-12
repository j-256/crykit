import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { acquireVerificationOwnership, createCheckpointSession, digest, readJson as readRecord, writeJson as writeRecord } from './verification-checkpoints.mjs'
import { runLogged } from './verification-playwright.mjs'
import { VERIFICATION_STEPS, VERIFICATION_COMMANDS, createVerificationPlan, readInstalled, readPrepared } from './verification-plan.mjs'
import { VerificationError } from './verification-error.mjs'
import { assertCoordinatedOwnership } from './verification-coordination.mjs'

const RECORD_VERSION = 2
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024
const runtime = Object.freeze({ node: process.version, platform: process.platform, arch: process.arch })

export { VerificationError } from './verification-error.mjs'

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] }).trim() }
  catch (error) { throw new VerificationError(error.code === 'ENOENT' ? 'Git is required' : 'Unable to inspect the Git checkout or published object', error.code === 'ENOENT' ? 3 : 2) }
}

export function verificationContext(cwd = process.cwd(), env = process.env) {
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  const commonDirectory = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const cacheRoot = env.XDG_CACHE_HOME || join(env.HOME || homedir(), '.cache')
  if (!isAbsolute(cacheRoot)) throw new VerificationError('XDG_CACHE_HOME must be an absolute directory')
  return {
    root,
    tree: git(root, ['rev-parse', 'HEAD^{tree}']),
    clean: git(root, ['status', '--porcelain', '--untracked-files=all']) === '',
    directory: join(cacheRoot, 'crykit-verification', digest(commonDirectory)),
  }
}

export function verificationRecordPath(context, tree = context.tree) {
  if (!OBJECT_ID_PATTERN.test(tree)) throw new VerificationError('Invalid Git tree ID')
  return join(context.directory, `${tree}-${digest(JSON.stringify(runtime))}.json`)
}

function passedRecord(record, tree, directory) {
  return record?.version === RECORD_VERSION && record.status === 'passed' && record.tree === tree &&
    JSON.stringify(record.runtime) === JSON.stringify(runtime) &&
    JSON.stringify(record.commands) === JSON.stringify(VERIFICATION_COMMANDS) &&
    typeof record.inputs === 'string' && /^[a-f0-9]{64}$/.test(record.inputs) &&
    typeof record.campaign === 'string' && Array.isArray(record.checkpoints?.executed) && Array.isArray(record.checkpoints?.reused) &&
    completeCoverage(record, directory) &&
    typeof record.completedAt === 'string' && Number.isFinite(Date.parse(record.completedAt))
}

function completeCoverage(record, directory) {
  const coverage = record.coverage
  if (!Array.isArray(coverage) || JSON.stringify(coverage.map(phase => phase?.command)) !== JSON.stringify(VERIFICATION_COMMANDS.slice(1))) return false
  if (coverage.some(phase => !Array.isArray(phase.checkpoints) || !phase.checkpoints.length || phase.checkpoints.some(id => typeof id !== 'string'))) return false
  const required = coverage.flatMap(phase => phase.checkpoints).sort()
  const completed = [...record.checkpoints.executed, ...record.checkpoints.reused].sort()
  if (new Set(required).size !== required.length || JSON.stringify(required) !== JSON.stringify(completed)) return false
  // The complete-plan receipt and durable campaign must agree; a truncated summary cannot qualify
  const campaign = readRecord(join(directory, 'checkpoints', `${record.inputs}.json`))
  if (campaign?.campaign !== record.campaign || !Array.isArray(campaign.steps)) return false
  const latest = new Map()
  for (const step of campaign.steps) {
    if (!step || typeof step.id !== 'string') return false
    latest.set(step.id, step.status)
  }
  return JSON.stringify([...latest].filter(([, status]) => status === 'passed').map(([id]) => id).sort()) === JSON.stringify(required)
}

async function runNpm(command, { cwd, env, log }) {
  const started = performance.now()
  process.stderr.write(`[verify] npm run ${command}\n`)
  try { await runLogged('npm', ['run', command], { cwd, env, log }) }
  catch (error) { throw new VerificationError(error.code === 'ENOENT' ? 'npm is required' : `npm run ${command} failed: ${error.message}`, error.code === 'ENOENT' ? 3 : 1) }
  process.stderr.write(`[verify] npm run ${command}: passed in ${((performance.now() - started) / 1000).toFixed(3)}s\n`)
}

export async function verifyIntegration({ cwd = process.cwd(), env = process.env, run = runNpm, ifNeeded = false, resume = false,
  readInstalled: installedIdentity = readInstalled, readPrepared: preparedIdentity = readPrepared, createPlan = createVerificationPlan,
  report = message => process.stderr.write(message + '\n') } = {}) {
  const before = verificationContext(cwd, env)
  const ownership = acquireVerificationOwnership(join(before.directory, 'ownership'))
  try {
    const options = { cwd: before.root, env, run }
    const path = verificationRecordPath(before)
    const attempt = randomUUID()
    const record = { version: RECORD_VERSION, status: 'running', attempt, tree: before.tree, runtime, commands: VERIFICATION_COMMANDS }
    let inputStamp
    const stamp = () => ({ 'installed tools': installedIdentity({ ...options, metadata: true }), 'prepared outputs': preparedIdentity({ ...options, metadata: true }) })
    const assertCurrent = () => {
      ownership.assertCurrent()
      assertCoordinatedOwnership(options)
      if (inputStamp !== undefined) {
        const currentStamp = stamp()
        const changed = Object.keys(inputStamp).filter(group => currentStamp[group] !== inputStamp[group])
        if (changed.length) throw new VerificationError(`Verification inputs changed during the run (${changed.join(', ')}); no publication record was created`)
      }
      const current = verificationContext(before.root, env)
      if (before.clean && (!current.clean || current.tree !== before.tree)) throw new VerificationError('Source changed during verification; commit and synchronize, then run npm run verify again')
      if (before.clean && readRecord(path)?.attempt !== attempt) throw new VerificationError('Another verification replaced this attempt; no publication record was created')
    }
    // Rebuild even on resume: a path or old successful receipt does not certify ignored build output
    // Invalidate publication immediately so failed preparation cannot leave a reusable full proof
    if (before.clean) writeRecord(path, record)
    const installed = installedIdentity(options)
    // Preparation must not switch the installation whose identity will label later checkpoints
    const installationStamp = installedIdentity({ ...options, metadata: true })
    await run(VERIFICATION_STEPS.prepare, options)
    assertCurrent()
    if (installedIdentity({ ...options, metadata: true }) !== installationStamp) throw new VerificationError('Verification inputs changed during preparation; no checkpoints were accepted')
    const prepared = preparedIdentity(options)
    inputStamp = stamp()
    const identity = JSON.stringify({ version: RECORD_VERSION, tree: before.tree, runtime, commands: VERIFICATION_COMMANDS, installed, prepared, ...(before.clean ? {} : { dirtyAttempt: attempt }) })
    const session = createCheckpointSession({ directory: join(before.directory, 'checkpoints'), identity,
      resume: before.clean && (resume || ifNeeded), assertCurrent, report })
    try {
      const plan = await createPlan(options)
      const coverage = new Map()
      const phase = async command => {
        const step = plan[command]
        if (!step) throw new VerificationError(`Missing required verification phase: ${command}`)
        const ids = []
        const phaseSession = { run: (id, ...args) => { ids.push(id); return session.run(id, ...args) } }
        if (step.partitioned) await step.execute(phaseSession)
        else {
          const artifacts = await phaseSession.run(command, step.execute, step.validate)
          await step.restore?.(artifacts)
        }
        coverage.set(command, ids)
      }
      // Preserve exclusive save deadlines and finish native archives before browser preparation
      await phase(VERIFICATION_STEPS.checks)
      await phase(VERIFICATION_STEPS.saves)
      await phase(VERIFICATION_STEPS.tests)
      // Keep coordinator ownership until both siblings finish, including after either fails
      const results = await Promise.allSettled([VERIFICATION_STEPS.browser, VERIFICATION_STEPS.accounts].map(phase))
      const failed = results.find(result => result.status === 'rejected')
      if (failed) throw failed.reason
      assertCurrent()
      if (installedIdentity(options) !== installed || preparedIdentity(options) !== prepared) {
        session.invalidate('Verification input contents changed')
        throw new VerificationError('Verification inputs changed during the run; no publication record was created')
      }
      assertCurrent()
      const checkpoints = session.summary()
      report(`[verify] Checkpoints: ${checkpoints.executed.length} executed, ${checkpoints.reused.length} reused, ${checkpoints.recovered.length} recovered`)
      if (checkpoints.recovered.length) report(`[verify] Earlier failed/interrupted steps recovered: ${checkpoints.recovered.join(', ')}`)
      if (!before.clean) {
        report('[verify] Checks passed without a publication record: commit all changes, synchronize, then run npm run verify again')
        return { recorded: false, tree: before.tree, checkpoints }
      }
      const completed = { ...record, status: 'passed', completedAt: new Date().toISOString(), inputs: digest(identity), campaign: session.campaign, checkpoints, coverage: VERIFICATION_COMMANDS.slice(1).map(command => ({ command, checkpoints: coverage.get(command) })) }
      if (!passedRecord(completed, before.tree, before.directory)) throw new VerificationError('Incomplete verification coverage; no publication record was created')
      writeRecord(path, completed)
      report(`[verify] Full desktop/mobile verification recorded for tree ${before.tree}`)
      return { recorded: true, ...(checkpoints.executed.length === 0 ? { reused: true } : {}), tree: before.tree, checkpoints }
    } catch (error) {
      try { assertCurrent() } catch (drift) { session.invalidate(drift.message); throw drift }
      throw error
    } finally { session.close() }
  } finally { ownership.close() }
}

export function checkPushVerification(input, { cwd = process.cwd(), env = process.env } = {}) {
  const updates = input.split('\n').filter(line => line.trim()).map(line => {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 4 || !OBJECT_ID_PATTERN.test(fields[1]) || !OBJECT_ID_PATTERN.test(fields[3])) throw new VerificationError('Invalid pre-push ref input')
    return { object: fields[1], ref: fields[2] }
  }).filter(update => !/^0+$/.test(update.object))
  if (!updates.length) return
  const context = verificationContext(cwd, env)
  if (!context.clean) throw new VerificationError('Publication requires a clean checkout; commit changes and run npm run verify in the task worktree')
  for (const update of updates) {
    const tree = git(context.root, ['rev-parse', '--verify', `${update.object}^{tree}`])
    if (!passedRecord(readRecord(verificationRecordPath(context, tree)), tree, context.directory)) {
      throw new VerificationError(`${update.ref}: full verification is missing or stale for tree ${tree}; run npm run verify in the clean, synchronized task worktree before retrying publication`)
    }
  }
}
