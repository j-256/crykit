// Node-only private controller bookkeeping, never imported by serving or browser code
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'

const VERSION = 1
const POLICY = 'crykit-private-qualification-v1'
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
const MIB = 1024 * 1024
const MAX_CLIENTS = 4
const MAX_ACCOUNTS = 4
const MAX_ACCOUNT_REVISIONS = 16
const MAX_LEDGER_BYTES = 32 * MIB
const BUSY_TIMEOUT_MS = 5000
const ROOT = resolve(import.meta.dirname, '../..')
const identifier = /^[A-Za-z0-9_-]{1,64}$/
const outcomes = Object.freeze(['complete', 'failed', 'uncertain'])
const limits = Object.freeze({ operations: 10_000, opaquePairs: 5000, emailAttempts: 50, ciphertextBytes: 32 * MIB, revisions: MAX_ACCOUNTS * MAX_ACCOUNT_REVISIONS, loadMs: 180 * MINUTE_MS, d1RowsRead: 2_000_000, d1RowsWritten: 100_000, r2ClassA: 20_000, r2ClassB: 100_000, d1MetadataBytes: 64 * MIB, d1RestoreBytes: 64 * MIB, r2Bytes: 256 * MIB, sourceContextBytes: 128 * MIB, restoreContextBytes: 128 * MIB })
const costKeys = Object.freeze(Object.keys(limits))
const minuteLimits = Object.freeze({ operations: 30, opaquePairs: 10 })
const dailyLimits = Object.freeze({ emailAttempts: 20, loadMs: 60 * MINUTE_MS })
const columns = costKeys.map(key => `"${key}"`).join(',')
const totalsSql = costKeys.map(key => `COALESCE(SUM("${key}"),0) AS "${key}"`).join(',')
const dayOf = now => Math.floor(now / DAY_MS)
const validNow = now => Number.isSafeInteger(now) && now >= 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())
const fail = () => { throw Error('QUALIFICATION_BUDGET_UNAVAILABLE') }
function requireValue(condition) { if (!condition) fail() }

async function connect(path, create = false) {
  requireValue(isAbsolute(path) && basename(path).endsWith('.sqlite'))
  // Protect SQLite journals as well as the main file, without changing another store's permissions
  const directory = await realpath(dirname(path))
  const root = await realpath(ROOT)
  requireValue(directory !== root && !directory.startsWith(root + '/'))
  const parent = await lstat(directory)
  requireValue(parent.isDirectory() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0)
  const handle = await open(path, constants.O_NOFOLLOW | constants.O_RDWR | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o600)
  try {
    const stat = await handle.stat()
    requireValue(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && stat.size <= MAX_LEDGER_BYTES)
    if (create) await handle.sync()
  } finally { await handle.close() }
  const db = new DatabaseSync(path)
  try {
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`)
    // Local rollback-journal mode avoids requiring a separately movable WAL recovery artifact
    requireValue(db.prepare('PRAGMA journal_mode').get().journal_mode === 'delete')
    return db
  } catch { db.close(); fail() }
}

async function transaction(path, action, { create = false, readOnly = false } = {}) {
  let db
  try {
    db = await connect(path, create)
    // IMMEDIATE serializes all readers of admission counters with competing process reservations
    // Accept only after COMMIT; a lost reply stays charged and must never authorize redispatch
    db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE')
    const result = action(db)
    db.exec('COMMIT')
    return result
  } catch {
    try { db?.exec('ROLLBACK') } catch { }
    fail()
  } finally { db?.close() }
}

function metadata(db, now) {
  const meta = db.prepare('SELECT * FROM metadata').all()
  requireValue(meta.length === 1 && meta[0].version === VERSION && meta[0].policy === POLICY && identifier.test(meta[0].runId) && validNow(meta[0].startedAt) && validNow(meta[0].lastAt) && meta[0].lastAt >= meta[0].startedAt && [0, 1].includes(meta[0].halted))
  if (now !== undefined) requireValue(validNow(now) && now >= meta[0].lastAt)
  return meta[0]
}
function totals(db, where = '', args = []) { return { ...db.prepare(`SELECT ${totalsSql} FROM reservations ${where}`).get(...args) } }
function snapshot(db) {
  const meta = metadata(db)
  return { version: VERSION, policy: POLICY, runId: meta.runId, startedAt: meta.startedAt, lastAt: meta.lastAt, halted: meta.halted === 1, reservationDayUtc: new Date(meta.lastAt).toISOString().slice(0, 10), historicalTotal: totals(db, "WHERE kind='historical'"), day: totals(db, 'WHERE day=?', [dayOf(meta.lastAt)]), total: totals(db), activeClients: db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE outcome='reserved'").get().n, accountCount: db.prepare('SELECT COUNT(DISTINCT accountId) AS n FROM reservations').get().n }
}
function validateRequest(input) {
  requireValue(exactKeys(input, ['id', 'clientId', 'accountId', 'emailRecipients', 'costs']) && identifier.test(input.id ?? '') && identifier.test(input.clientId ?? '') && (input.accountId === null || identifier.test(input.accountId ?? '')))
  requireValue(exactKeys(input.costs, costKeys) && costKeys.every(key => Number.isSafeInteger(input.costs[key]) && input.costs[key] >= 0) && input.costs.operations > 0 && input.costs.operations >= 2 * input.costs.opaquePairs)
  requireValue(input.accountId !== null || (input.costs.revisions === 0 && input.costs.ciphertextBytes === 0))
  requireValue(Array.isArray(input.emailRecipients) && new Set(input.emailRecipients).size === input.emailRecipients.length)
  if (input.costs.emailAttempts > 0) requireValue(input.emailRecipients.length > 0 && input.emailRecipients.length <= input.costs.emailAttempts && input.emailRecipients.every(value => typeof value === 'string' && /^[a-z0-9][a-z0-9+._-]*@crykit\.lasers\.app$/.test(value)))
  else requireValue(input.emailRecipients.length === 0)
  // Retain a digest rather than mailbox values; changed recipients cannot reuse an accepted ID
  return createHash('sha256').update(JSON.stringify([input.clientId, input.accountId, [...input.emailRecipients].sort(), costKeys.map(key => input.costs[key])])).digest('hex')
}
function immutableRequest(value) {
  let input
  try { input = structuredClone(value) } catch { fail() }
  const digest = validateRequest(input)
  // Filesystem awaits let callers reuse or mutate their request while admission is pending
  // Charge and hash one detached identity so a later edit cannot authorize uncharged work
  Object.freeze(input.costs)
  Object.freeze(input.emailRecipients)
  return { input: Object.freeze(input), digest }
}
function within(used, cost, ceilings) {
  return Object.entries(ceilings).every(([key, max]) => Number.isSafeInteger(used[key]) && used[key] >= 0 && used[key] <= max && cost[key] <= max - used[key])
}
function admitted(used, cost, ceilings) { requireValue(within(used, cost, ceilings)) }
function insertWork(db, input, digest, now, notAfter, kind) {
  const outcome = kind === 'historical' ? 'uncertain' : 'reserved'
  db.prepare(`INSERT INTO reservations(id,clientId,accountId,digest,createdAt,day,notAfter,outcome,kind,${columns}) VALUES(?,?,?,?,?,?,?,?,?,${costKeys.map(() => '?').join(',')})`).run(input.id, input.clientId, input.accountId, digest, now, dayOf(now), notAfter, outcome, kind, ...costKeys.map(key => input.costs[key]))
  db.prepare('UPDATE metadata SET lastAt=?').run(now)
}

export async function createQualificationBudget(path, runId, now = Date.now()) {
  requireValue(identifier.test(runId ?? '') && validNow(now))
  return transaction(path, db => {
    db.exec(`CREATE TABLE metadata(version INTEGER NOT NULL, policy TEXT NOT NULL, runId TEXT NOT NULL, startedAt INTEGER NOT NULL, lastAt INTEGER NOT NULL, halted INTEGER NOT NULL CHECK(halted IN (0,1))) STRICT;
      CREATE TABLE reservations(id TEXT PRIMARY KEY, clientId TEXT NOT NULL, accountId TEXT, digest TEXT NOT NULL, createdAt INTEGER NOT NULL, day INTEGER NOT NULL, notAfter INTEGER, outcome TEXT NOT NULL CHECK(outcome IN ('reserved','complete','failed','uncertain')), kind TEXT NOT NULL CHECK(kind IN ('reservation','historical')), completedAt INTEGER, ${costKeys.map(key => `"${key}" INTEGER NOT NULL CHECK("${key}">=0)`).join(',')}) STRICT;
      CREATE INDEX reservations_time ON reservations(createdAt); CREATE INDEX reservations_day ON reservations(day); CREATE INDEX reservations_account ON reservations(accountId);`)
    db.prepare('INSERT INTO metadata VALUES(?,?,?,?,?,0)').run(VERSION, POLICY, runId, now, now)
    return snapshot(db)
  }, { create: true })
}

export async function reserveQualificationWork(path, value, now = Date.now()) {
  const { input, digest } = immutableRequest(value)
  return transaction(path, db => {
    metadata(db, now)
    const prior = db.prepare('SELECT digest,outcome,notAfter,kind FROM reservations WHERE id=?').get(input.id)
    if (prior) {
      requireValue(prior.digest === digest && prior.kind === 'reservation')
      return { dispatchAllowed: false, id: input.id, outcome: prior.outcome, notAfter: prior.notAfter }
    }
    requireValue(metadata(db).halted === 0)
    const active = db.prepare("SELECT clientId FROM reservations WHERE outcome='reserved'").all()
    requireValue(active.length < MAX_CLIENTS && active.every(row => row.clientId !== input.clientId))
    if (input.accountId !== null) {
      const accounts = db.prepare('SELECT DISTINCT accountId FROM reservations WHERE accountId IS NOT NULL').all().map(row => row.accountId)
      requireValue(accounts.includes(input.accountId) || accounts.length < MAX_ACCOUNTS)
      const accountRevisions = db.prepare('SELECT COALESCE(SUM(revisions),0) AS n FROM reservations WHERE accountId=?').get(input.accountId).n
      requireValue(input.costs.revisions <= MAX_ACCOUNT_REVISIONS - accountRevisions)
    }
    admitted(totals(db), input.costs, limits)
    admitted(totals(db, 'WHERE createdAt>?', [now - MINUTE_MS]), input.costs, minuteLimits)
    admitted(totals(db, 'WHERE day=?', [dayOf(now)]), input.costs, dailyLimits)
    // A load window crossing midnight needs a separately reserved next-day segment
    // The controller must stop at notAfter; the ledger cannot terminate remote or ignored work
    const notAfter = input.costs.loadMs > 0 ? now + input.costs.loadMs : null
    requireValue(notAfter === null || (Number.isSafeInteger(notAfter) && dayOf(notAfter - 1) === dayOf(now)))
    insertWork(db, input, digest, now, notAfter, 'reservation')
    return { dispatchAllowed: true, id: input.id, outcome: 'reserved', notAfter }
  })
}

export async function recordHistoricalQualificationWork(path, value, now = Date.now()) {
  const { input, digest } = immutableRequest(value)
  return transaction(path, db => {
    metadata(db, now)
    const prior = db.prepare('SELECT digest,kind FROM reservations WHERE id=?').get(input.id)
    if (prior) {
      requireValue(prior.digest === digest && prior.kind === 'historical')
      return { dispatchAllowed: false, id: input.id, historical: true }
    }
    const fits = within(totals(db), input.costs, limits) && within(totals(db, 'WHERE createdAt>?', [now - MINUTE_MS]), input.costs, minuteLimits) && within(totals(db, 'WHERE day=?', [dayOf(now)]), input.costs, dailyLimits)
    // Historical spend is evidence, never a retroactive reservation or permission to dispatch
    // Preserve even an observed overage, then halt future admission rather than hiding the excess
    insertWork(db, input, digest, now, null, 'historical')
    const accounts = db.prepare('SELECT COUNT(DISTINCT accountId) AS n FROM reservations').get().n
    const excessRevisions = db.prepare('SELECT 1 FROM reservations WHERE accountId IS NOT NULL GROUP BY accountId HAVING SUM(revisions)>? LIMIT 1').get(MAX_ACCOUNT_REVISIONS)
    if (!fits || accounts > MAX_ACCOUNTS || excessRevisions) db.prepare('UPDATE metadata SET halted=1').run()
    return { dispatchAllowed: false, id: input.id, historical: true }
  })
}

export async function finishQualificationWork(path, id, outcome, now = Date.now()) {
  requireValue(identifier.test(id ?? '') && outcomes.includes(outcome))
  return transaction(path, db => {
    metadata(db, now)
    const prior = db.prepare('SELECT outcome,notAfter FROM reservations WHERE id=?').get(id)
    requireValue(prior && (prior.outcome === 'reserved' || prior.outcome === outcome))
    if (prior.outcome !== 'reserved') return snapshot(db)
    // Completion releases only the client slot; attempts, allocations and uncertain work are never refunded
    const overrun = prior.notAfter !== null && now > prior.notAfter
    const observedOutcome = overrun ? 'uncertain' : outcome
    if (overrun) db.prepare('UPDATE metadata SET halted=1').run()
    db.prepare("UPDATE reservations SET outcome=?,completedAt=? WHERE id=? AND outcome='reserved'").run(observedOutcome, now, id)
    db.prepare('UPDATE metadata SET lastAt=?').run(now)
    return snapshot(db)
  })
}

export async function readQualificationBudget(path) { return transaction(path, snapshot, { readOnly: true }) }
