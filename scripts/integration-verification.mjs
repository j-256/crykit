import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

const RECORD_VERSION = 1
const VERIFICATION_COMMANDS = Object.freeze(['check', 'test:e2e'])
const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024
const runtime = Object.freeze({ node: process.version, platform: process.platform, arch: process.arch })
const digest = value => createHash('sha256').update(value).digest('hex')

export class VerificationError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.exitCode = exitCode
  }
}

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

function readRecord(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { return undefined }
}

function writeRecord(path, record) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

function passedRecord(record, tree) {
  return record?.version === RECORD_VERSION && record.status === 'passed' && record.tree === tree &&
    JSON.stringify(record.runtime) === JSON.stringify(runtime) &&
    JSON.stringify(record.commands) === JSON.stringify(VERIFICATION_COMMANDS) &&
    typeof record.completedAt === 'string' && Number.isFinite(Date.parse(record.completedAt))
}

async function runNpm(command, { cwd, env }) {
  process.stderr.write(`[verify] npm run ${command}\n`)
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', command], { cwd, env, stdio: 'inherit' })
    child.once('error', error => reject(new VerificationError(error.code === 'ENOENT' ? 'npm is required' : `Unable to run npm run ${command}`, error.code === 'ENOENT' ? 3 : 1)))
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new VerificationError(`npm run ${command} failed${signal ? ` (${signal})` : ''}; no publication record was created`, code || 1)))
  })
}

export async function verifyIntegration({ cwd = process.cwd(), env = process.env, run = runNpm, report = message => process.stderr.write(message + '\n') } = {}) {
  const before = verificationContext(cwd, env)
  const path = verificationRecordPath(before)
  const attempt = randomUUID()
  const record = { version: RECORD_VERSION, status: 'running', attempt, tree: before.tree, runtime, commands: VERIFICATION_COMMANDS }
  // Invalidate prior success before running so failures and interruptions cannot retain it
  if (before.clean) writeRecord(path, record)
  for (const command of VERIFICATION_COMMANDS) await run(command, { cwd: before.root, env })
  const after = verificationContext(before.root, env)
  if (!before.clean) {
    report('[verify] Checks passed without a publication record: commit all changes, synchronize, then run npm run verify again')
    return { recorded: false, tree: before.tree }
  }
  if (!after.clean || after.tree !== before.tree) throw new VerificationError('Source changed during verification; commit and synchronize, then run npm run verify again')
  if (readRecord(path)?.attempt !== attempt) throw new VerificationError('Another verification replaced this attempt; no publication record was created')
  writeRecord(path, { ...record, status: 'passed', completedAt: new Date().toISOString() })
  report(`[verify] Full desktop/mobile verification recorded for tree ${before.tree}`)
  return { recorded: true, tree: before.tree }
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
    if (!passedRecord(readRecord(verificationRecordPath(context, tree)), tree)) {
      throw new VerificationError(`${update.ref}: full verification is missing or stale for tree ${tree}; run npm run verify in the clean, synchronized task worktree before retrying publication`)
    }
  }
}
