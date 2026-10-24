import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types/experimental'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServiceFixture, type ServiceFixture } from '../testing/service-fixture'
import { runGuardedBatch, type SqlGuard } from './guarded-batch'

const previousBytes = 100
const owner = 'owner'
const stages = ['guard', 'dependency', 'head', 'quota', 'receipt'] as const

// These domain tables are synthetic consumers, not a prematurely frozen service schema
const schema = `
CREATE TABLE probe_accounts (id TEXT PRIMARY KEY, status TEXT NOT NULL, credential_revision INTEGER NOT NULL, used_bytes INTEGER NOT NULL, capacity_bytes INTEGER NOT NULL);
CREATE TABLE probe_heads (account_id TEXT NOT NULL, document_id TEXT NOT NULL, revision_id TEXT NOT NULL, PRIMARY KEY (account_id, document_id));
CREATE TABLE probe_dependencies (revision_id TEXT PRIMARY KEY, dependency_id TEXT NOT NULL);
CREATE TABLE probe_receipts (mutation_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL);
INSERT INTO probe_accounts VALUES ('owner', 'active', 1, 100, 1000), ('foreign', 'active', 1, 200, 1000);
INSERT INTO probe_heads VALUES ('owner', 'document', 'previous'), ('foreign', 'document', 'private');
`

function expectedHeadGuard(revision: string | null = 'previous', accountId = owner, charge = 7): SqlGuard {
  return {
    // A missing SELECT row must fail, rather than silently skipping the guard INSERT
    sql: `SELECT 1 FROM probe_accounts a WHERE a.id = ? AND a.status = 'active'
      AND a.used_bytes + ? <= a.capacity_bytes
      AND (SELECT revision_id FROM probe_heads WHERE account_id = a.id AND document_id = ?) IS ?`,
    bindings: [accountId, charge, 'document', revision],
  }
}

function writes(db: D1Database, revision: string, charge = 7): D1PreparedStatement[] {
  return [
    db.prepare('INSERT INTO probe_dependencies VALUES (?, ?)').bind(revision, 'dependency'),
    db.prepare('UPDATE probe_heads SET revision_id = ? WHERE account_id = ? AND document_id = ?').bind(revision, owner, 'document'),
    db.prepare('UPDATE probe_accounts SET used_bytes = used_bytes + ? WHERE id = ?').bind(charge, owner),
    db.prepare('INSERT INTO probe_receipts VALUES (?, ?)').bind(`mutation-${revision}`, revision),
  ]
}

async function snapshot(db: D1Database) {
  const tables = ['probe_accounts', 'probe_heads', 'probe_dependencies', 'probe_receipts', 'transaction_guards']
  const results = await db.batch(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`)))
  return results.map(result => result.results)
}

// Every case starts a new in-memory Miniflare database; rounds expose cross-run state assumptions
for (const round of ['first', 'second', 'third']) describe(`real D1 guard ${round} database round`, () => {
  let fixture: ServiceFixture
  let db: D1Database
  beforeEach(async () => {
    fixture = await createServiceFixture()
    db = fixture.db
    await db.exec(schema)
  })
  afterEach(async () => { await fixture?.dispose() })

  it('zeroRowPreconditionRollsBackAllStatements', async () => {
    const before = await snapshot(db)
    await expect(runGuardedBatch(db, expectedHeadGuard('stale'), writes(db, 'loser'))).rejects.toThrow(/CHECK constraint failed/)
    expect(await snapshot(db)).toEqual(before)
  })

  it('concurrentExpectedHeadProducesOneWinner', async ({ annotate }) => {
    const candidates = [{ revision: 'left', charge: 7 }, { revision: 'right', charge: 11 }]
    if (round === 'second') candidates.reverse()
    const results = await Promise.allSettled(candidates.map(candidate => runGuardedBatch(db, expectedHeadGuard('previous', owner, candidate.charge), writes(db, candidate.revision, candidate.charge))))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const winner = candidates[results.findIndex(result => result.status === 'fulfilled')]!
    const loser = candidates[results.findIndex(result => result.status === 'rejected')]!
    const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(String(rejection.reason)).toContain('CHECK constraint failed')
    const head = await db.prepare('SELECT revision_id FROM probe_heads WHERE account_id = ? AND document_id = ?').bind(owner, 'document').first('revision_id')
    expect(head).toBe(winner.revision)
    expect((await db.prepare('SELECT * FROM probe_dependencies WHERE revision_id = ?').bind(loser.revision).all()).results).toEqual([])
    expect((await db.prepare('SELECT * FROM probe_receipts').all()).results).toEqual([{ mutation_id: `mutation-${winner.revision}`, revision_id: winner.revision }])
    expect((await db.prepare('SELECT * FROM probe_dependencies').all()).results).toEqual([{ revision_id: winner.revision, dependency_id: 'dependency' }])
    const usedBytes = await db.prepare('SELECT used_bytes FROM probe_accounts WHERE id = ?').bind(owner).first('used_bytes')
    expect(usedBytes).toBe(previousBytes + winner.charge)
    expect((await db.prepare('SELECT * FROM transaction_guards').all()).results).toEqual([])
    const success = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof runGuardedBatch>>>
    expect(success.value.map(result => result.meta.changes)).toEqual([1, 1, 1, 1])
    await annotate(`database=${round}; winner=${winner.revision}; head=${head}; usedBytes=${usedBytes}; loser=${loser.revision}; loserDependencies=[]; receipts=1; guards=0`, 'D1 observation')
  })

  it('receiptFailureRollsBackQuotaAndPointers', async () => {
    const before = await snapshot(db)
    const statements = writes(db, 'failed')
    statements[3] = db.prepare('INSERT INTO probe_receipts VALUES (?, NULL)').bind('failed')
    await expect(runGuardedBatch(db, expectedHeadGuard(), statements)).rejects.toThrow(/NOT NULL constraint failed/)
    expect(await snapshot(db)).toEqual(before)
  })

  it.each(stages)('SQL failure after %s preserves complete prior state', async stage => {
    const before = await snapshot(db)
    // This statement executes inside SQLite after the named write, with no JS fault checkpoint
    const failure = db.prepare('INSERT INTO probe_receipts VALUES (?, NULL)').bind('injected-failure')
    const statements = writes(db, 'failed')
    statements.splice(stages.indexOf(stage), 0, failure)
    await expect(runGuardedBatch(db, expectedHeadGuard(), statements)).rejects.toThrow(/NOT NULL constraint failed/)
    expect(await snapshot(db)).toEqual(before)
  })

  it('guardsManyExpectedHeadsWithBoundJsonIncludingAbsentHeads', async () => {
    const expected = Array.from({ length: 31 }, (_, index) => ({ documentId: `document-${index}`, revisionId: `revision-${index}` }))
    await db.batch(expected.map(head => db.prepare('INSERT INTO probe_heads VALUES (?, ?, ?)').bind(owner, head.documentId, head.revisionId)))
    const heads: { documentId: string; revisionId: string | null }[] = [...expected, { documentId: 'absent', revisionId: null }]
    const guard = (): SqlGuard => ({
      // NOT EXISTS checks the complete bounded set without one SQL statement per head
      sql: `SELECT 1 FROM probe_accounts a WHERE a.id = ? AND a.status = 'active' AND NOT EXISTS (
        SELECT 1 FROM json_each(?) expected
        WHERE (SELECT revision_id FROM probe_heads WHERE account_id = a.id AND document_id = json_extract(expected.value, '$.documentId'))
          IS NOT json_extract(expected.value, '$.revisionId'))`,
      bindings: [owner, JSON.stringify(heads)],
    })
    const results = await runGuardedBatch(db, guard(), [db.prepare('INSERT INTO probe_receipts VALUES (?, ?) RETURNING revision_id').bind('json-proof', 'ready')])
    expect(results[0]?.results).toEqual([{ revision_id: 'ready' }])
    const before = await snapshot(db)
    heads[17]!.revisionId = 'stale'
    await expect(runGuardedBatch(db, guard(), writes(db, 'stale-json'))).rejects.toThrow(/CHECK constraint failed/)
    expect(await snapshot(db)).toEqual(before)
  })

  it.each(['ownership', 'policy', 'quota', 'credential'])('rejects a stale %s predicate', async boundary => {
    const guard: SqlGuard = boundary === 'ownership' ? expectedHeadGuard('private')
      : boundary === 'quota' ? expectedHeadGuard('previous', owner, 901)
      : { sql: `SELECT 1 FROM probe_accounts WHERE id = ? AND ${boundary === 'policy' ? "status = 'blocked'" : 'credential_revision = 2'}`, bindings: [owner] }
    const before = await snapshot(db)
    await expect(runGuardedBatch(db, guard, writes(db, 'unauthorized'))).rejects.toThrow(/CHECK constraint failed/)
    expect(await snapshot(db)).toEqual(before)
  })

  it('treatsNullAndZeroScalarPredicatesAsFailedGuards', async () => {
    const before = await snapshot(db)
    for (const value of [null, 0]) {
      await expect(runGuardedBatch(db, { sql: 'SELECT ?', bindings: [value] }, writes(db, 'false-guard'))).rejects.toThrow(/CHECK constraint failed/)
      expect(await snapshot(db)).toEqual(before)
    }
  })
})
