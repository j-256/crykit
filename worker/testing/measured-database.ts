import type { D1Database } from '@cloudflare/workers-types/experimental'

const sqlEncoder = new TextEncoder()
const queryMethods = new Set(['first', 'all', 'run', 'raw'])

// The same counters wrap Node proxies and native Worker bindings so moving execution cannot hide work
export function measuredDatabase(db: D1Database) {
  const values = { queries: 0, maxBatchStatements: 0, maxBindings: 0, maxSqlBytes: 0, rowsRead: 0, rowsWritten: 0 }
  const originals = new WeakMap<object, ReturnType<typeof db.prepare>>()
  const wrap = (statement: ReturnType<typeof db.prepare>): ReturnType<typeof db.prepare> => {
    const proxy = new Proxy(statement, { get(target, key) {
      if (key === 'bind') return (...args: Parameters<typeof target.bind>) => {
        values.maxBindings = Math.max(values.maxBindings, args.length)
        return wrap(target.bind(...args))
      }
      if (queryMethods.has(String(key))) return (...args: unknown[]) => {
        values.queries++
        return (Reflect.get(target, key) as (...args: unknown[]) => unknown).apply(target, args)
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    // Native batch must receive its original statements, including the bound parameters
    originals.set(proxy, statement)
    return proxy
  }
  const proxy = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      values.maxSqlBytes = Math.max(values.maxSqlBytes, sqlEncoder.encode(sql).byteLength)
      return wrap(target.prepare(sql))
    }
    if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
      values.queries += args[0].length
      values.maxBatchStatements = Math.max(values.maxBatchStatements, args[0].length)
      const result = await target.batch(args[0].map(statement => originals.get(statement) ?? statement))
      for (const row of result) { values.rowsRead += row.meta.rows_read; values.rowsWritten += row.meta.rows_written }
      return result
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  return { db: proxy, values, reset() { for (const key of Object.keys(values) as (keyof typeof values)[]) values[key] = 0 } }
}

export type DatabaseMeasurements = ReturnType<typeof measuredDatabase>['values']
