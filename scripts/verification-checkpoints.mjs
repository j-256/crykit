import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const CHECKPOINT_VERSION = 1
export const digest = value => createHash('sha256').update(value).digest('hex')
export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

// Hash names and bytes, not mtimes: rebuilding identical inputs must preserve reuse
// Dependency links include their target bytes so editing a linked package invalidates evidence
export function fingerprintPaths(root, paths) {
  const hash = createHash('sha256')
  const visit = (path, name, ancestors = new Set()) => {
    const stat = lstatSync(path)
    hash.update(JSON.stringify([name, stat.mode & 0o777]))
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path)
      if (ancestors.has(path)) throw new Error(`Cyclic verification input: ${name}`)
      hash.update(JSON.stringify(['link', target]))
      visit(resolve(dirname(path), target), name, new Set([...ancestors, path]))
    } else if (stat.isDirectory()) {
      hash.update('directory')
      for (const child of readdirSync(path).sort()) visit(join(path, child), `${name}/${child}`, ancestors)
    } else if (stat.isFile()) {
      hash.update(JSON.stringify(['file', stat.size]))
      hash.update(readFileSync(path))
    } else throw new Error(`Unsupported verification input: ${name}`)
  }
  for (const path of [...paths].sort()) visit(join(root, path), path)
  return hash.digest('hex')
}

function acquireLock(path, owner) {
  const claim = () => writeFileSync(path, JSON.stringify(owner), { mode: 0o600, flag: 'wx' })
  try { claim(); return } catch (error) { if (error.code !== 'EEXIST') throw error }
  const previous = readJson(path)
  if (!Number.isInteger(previous?.pid) || previous.pid <= 0) throw new Error(`Uncertain verification owner: inspect ${path}`)
  try { process.kill(previous.pid, 0) } catch (error) {
    if (error.code !== 'ESRCH') throw error
    // Coordinator recovery remains authoritative; this only clears a dead local process lock
    // Rename the stale file before claiming so another claimant's lock cannot be unlinked
    const stale = `${path}.${previous.attempt}.stale`
    renameSync(path, stale)
    if (readJson(stale)?.attempt !== previous.attempt) throw new Error(`Verification ownership changed: inspect ${stale}`)
    claim()
    return
  }
  throw new Error(`Verification is already active (PID ${previous.pid})`)
}

export function createCheckpointSession({ directory, identity, resume = false, assertCurrent = () => {}, report = () => {} }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const owner = { pid: process.pid, attempt: randomUUID() }
  const lock = join(directory, 'active.json')
  acquireLock(lock, owner)
  const path = join(directory, `${digest(identity)}.json`)
  const previous = resume ? readJson(path) : undefined
  const record = previous?.version === CHECKPOINT_VERSION && previous.identity === identity && Array.isArray(previous.steps)
    ? previous : { version: CHECKPOINT_VERSION, identity, campaign: randomUUID(), steps: [] }
  const reused = []
  const executed = []
  const recovered = []
  const active = new Set()
  const assertOwner = () => {
    if (readJson(lock)?.attempt !== owner.attempt) throw new Error('Another verification replaced this checkpoint owner')
    assertCurrent()
  }
  return {
    campaign: record.campaign,
    async run(id, execute, validate = () => {}) {
      assertOwner()
      if (active.has(id)) throw new Error(`Checkpoint already running: ${id}`)
      active.add(id)
      try {
        const history = record.steps.filter(step => step.id === id)
        const saved = history.at(-1)
        if (saved?.status === 'passed') {
          try {
            await validate(saved.directory)
            assertOwner()
            reused.push(id)
            report(`[verify] Reusing ${id}`)
            return saved.directory
          } catch (error) {
            assertOwner()
            report(`[verify] Rechecking ${id}: saved evidence is unavailable or invalid (${error.message})`)
          }
        }
        const artifacts = join(directory, record.campaign, owner.attempt, digest(id))
        mkdirSync(artifacts, { recursive: true, mode: 0o700 })
        const step = { id, status: 'running', directory: artifacts, attempt: owner.attempt, startedAt: new Date().toISOString() }
        record.steps.push(step)
        writeJson(path, record)
        executed.push(id)
        try {
          await execute(artifacts)
          await validate(artifacts)
          assertOwner()
          step.status = 'passed'
          step.completedAt = new Date().toISOString()
          if (history.some(item => item.status !== 'passed')) recovered.push(id)
        } catch (error) {
          step.status = 'failed'
          step.error = error.message
          throw error
        } finally {
          // Sibling completions share this in-memory record; synchronous writes cannot lose updates
          if (readJson(lock)?.attempt === owner.attempt) writeJson(path, record)
        }
        return artifacts
      } finally { active.delete(id) }
    },
    summary: () => ({ reused: [...reused], executed: [...executed], recovered: [...recovered] }),
    close() {
      if (active.size) throw new Error('Cannot close verification while checkpoints are running')
      if (readJson(lock)?.attempt === owner.attempt) unlinkSync(lock)
    },
  }
}
