import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types/experimental'

export const databaseRequestPath = '/__accounts/probe/database'
type Statement = { readonly sql: string; readonly values: readonly unknown[] }
type DatabaseRequest =
  | { readonly operation: 'statement'; readonly statement: Statement; readonly method: 'first' | 'all' | 'run' | 'raw'; readonly argument?: unknown }
  | { readonly operation: 'batch'; readonly statements: readonly Statement[] }
  | { readonly operation: 'exec'; readonly sql: string }
type DatabaseError = { readonly name: string; readonly message: string; readonly cause?: DatabaseError }
type DatabaseResponse = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: DatabaseError }

function errorRecord(error: unknown, depth = 0): DatabaseError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) }
  return { name: error.name, message: error.message, ...(error.cause && depth < 3 ? { cause: errorRecord(error.cause, depth + 1) } : {}) }
}
function restoreError(error: DatabaseError): Error {
  return Object.assign(new Error(error.message, error.cause ? { cause: restoreError(error.cause) } : undefined), { name: error.name })
}

// Only the excluded local entry accepts these synthetic fixture commands
// Every execution still uses native D1, including transaction boundaries, triggers and result metadata
export async function executeDatabaseRequest(request: Request, db: D1Database): Promise<Response> {
  const input = await request.json() as DatabaseRequest
  const prepare = ({ sql, values }: Statement) => values.length ? db.prepare(sql).bind(...values) : db.prepare(sql)
  try {
    let value: unknown
    if (input.operation === 'batch') value = await db.batch(input.statements.map(prepare))
    else if (input.operation === 'exec') value = await db.exec(input.sql)
    else if (input.operation === 'statement') {
      const statement = prepare(input.statement)
      if (input.method === 'first') value = input.argument === undefined ? await statement.first() : await statement.first(input.argument as string)
      else if (input.method === 'raw') value = await statement.raw(input.argument as { columnNames?: false })
      else if (input.method === 'all' || input.method === 'run') value = await statement[input.method]()
      else throw new TypeError('Unsupported fixture statement operation')
    } else throw new TypeError('Unsupported fixture database operation')
    return Response.json({ ok: true, value } satisfies DatabaseResponse)
  } catch (error) { return Response.json({ ok: false, error: errorRecord(error) } satisfies DatabaseResponse) }
}

function bindingValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  if (value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value) && value.every(item => Number.isInteger(item) && item >= 0 && item <= 255)) return [...value]
  // JSON would silently turn unsupported undefined/nonfinite values into SQL null
  // Fail closed; use the original binding transport for tests of unsupported API inputs
  throw new TypeError('Unsupported fixture SQL binding')
}

// Miniflare's binding proxy makes synchronous HTTP calls for prepare/bind as well as execution
// Keep immutable query construction local and cross once per execution, without interpreting SQL
export function requestDatabase(binding: D1Database, send: (body: string) => Promise<Response>): D1Database {
  const statements = new WeakMap<D1PreparedStatement, Statement>()
  const execute = async (input: DatabaseRequest) => {
    const response = await send(JSON.stringify(input))
    if (!response.ok) throw new Error(`Local database request rejected (${response.status})`)
    const result = await response.json() as DatabaseResponse
    if (!result.ok) throw restoreError(result.error)
    return result.value
  }
  const prepare = (sql: string, values: readonly unknown[] = []): D1PreparedStatement => {
    const statement = { sql, values }
    const result = {
      bind: (...values: unknown[]) => prepare(sql, values.map(bindingValue)),
      first: (argument?: string) => execute({ operation: 'statement', statement, method: 'first', argument }),
      all: () => execute({ operation: 'statement', statement, method: 'all' }),
      run: () => execute({ operation: 'statement', statement, method: 'run' }),
      raw: (argument?: { columnNames?: boolean }) => execute({ operation: 'statement', statement, method: 'raw', argument }),
    } as D1PreparedStatement
    statements.set(result, statement)
    return result
  }
  return new Proxy(binding, { get(target, key) {
    if (key === 'prepare') return prepare
    if (key === 'batch') return (batch: D1PreparedStatement[]) => execute({ operation: 'batch', statements: batch.map(statement => {
      const value = statements.get(statement)
      if (!value) throw new TypeError('A fixture batch cannot borrow statements from another database')
      return value
    }) })
    if (key === 'exec') return (sql: string) => execute({ operation: 'exec', sql })
    // Session/bookmark and legacy dump API proofs retain the original native binding transport
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}
