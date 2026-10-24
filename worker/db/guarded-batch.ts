import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types/experimental'

export type SqlGuard = {
  // Trusted internal scalar SELECT only; all request-derived values belong in bindings
  readonly sql: string
  readonly bindings: readonly (string | number | null | ArrayBuffer)[]
}

export async function runGuardedBatch(db: D1Database, guard: SqlGuard, statements: readonly D1PreparedStatement[]): Promise<readonly D1Result[]> {
  const id = crypto.randomUUID()
  // A scalar SELECT with no rows yields NULL, which must become a CHECK failure
  // INSERT ... SELECT ... WHERE predicate would instead skip insertion and permit later writes
  const precondition = db.prepare(`INSERT INTO transaction_guards (id, passed) VALUES (?, CASE WHEN COALESCE((${guard.sql}), 0) THEN 1 ELSE 0 END)`).bind(id, ...guard.bindings)
  const cleanup = db.prepare('DELETE FROM transaction_guards WHERE id = ?').bind(id)
  // D1 owns the single transaction: no preflight reads, JS write loop or separate cleanup
  // Preserve raw database rejection internally; HTTP callers must classify it without returning causes
  const results = await db.batch([precondition, ...statements, cleanup])
  return results.slice(1, -1)
}
