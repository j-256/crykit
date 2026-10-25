import { afterEach, expect, it } from 'vitest'
import { createServiceFixture, type ServiceFixture } from './service-fixture'

const fixtures: ServiceFixture[] = []
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose())) })

it.each(['binding', 'request'] as const)('retains native D1 results, transaction rollback and independent storage through %s transport', async databaseTransport => {
  const fixture = await createServiceFixture({ databaseTransport })
  fixtures.push(fixture)
  const db = fixture.db
  await db.exec('CREATE TABLE transport_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL, bytes BLOB)')
  const insert = db.prepare('INSERT INTO transport_probe VALUES (?, ?, ?)')
  const first = insert.bind(1, 'first', new Uint8Array([0, 127, 255]))
  const second = insert.bind(2, 'second', null)
  const result = await db.batch([first, second])
  expect(result).toHaveLength(2)
  expect(result.every(row => row.success && row.meta.changes === 1 && row.meta.rows_written > 0)).toBe(true)
  expect(await db.prepare('SELECT value FROM transport_probe WHERE id = ?').bind(1).first('value')).toBe('first')
  expect(await db.prepare('SELECT value FROM transport_probe WHERE id = ?').bind(3).first()).toBeNull()
  expect(await db.prepare('SELECT id, value FROM transport_probe ORDER BY id').raw({ columnNames: true })).toEqual([['id', 'value'], [1, 'first'], [2, 'second']])
  expect((await db.prepare('SELECT hex(bytes) AS bytes FROM transport_probe WHERE id = 1').all()).results).toEqual([{ bytes: '007FFF' }])
  await expect(db.prepare('SELECT value FROM transport_probe').first('missing')).rejects.toThrow('D1_COLUMN_NOTFOUND')
  await expect(db.batch([insert.bind(3, 'rolled back', null), insert.bind(1, 'duplicate', null)])).rejects.toThrow('UNIQUE constraint failed')
  expect(await db.prepare('SELECT COUNT(*) AS n FROM transport_probe').first('n')).toBe(2)
  await db.exec("CREATE TRIGGER reject_transport BEFORE UPDATE ON transport_probe BEGIN SELECT RAISE(ABORT, 'synthetic transport failure'); END")
  await expect(db.prepare("UPDATE transport_probe SET value = 'changed'").run()).rejects.toThrow('synthetic transport failure')
  expect(await db.prepare('SELECT value FROM transport_probe WHERE id = 1').first('value')).toBe('first')
  if (databaseTransport === 'request') {
    const response = await fixture.request('/__accounts/probe/database', { method: 'POST', body: JSON.stringify({ operation: 'statement', statement: { sql: 'SELECT COUNT(*) AS n FROM transport_probe', values: [] }, method: 'first', argument: 'n' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, value: 2 })
  }
  const independent = await createServiceFixture({ databaseTransport })
  fixtures.push(independent)
  expect(await independent.db.prepare("SELECT name FROM sqlite_master WHERE name = 'transport_probe'").first()).toBeNull()
})

it('does not expose fixture SQL execution from the production entry', async () => {
  const fixture = await createServiceFixture({ production: true })
  fixtures.push(fixture)
  const response = await fixture.request('/__accounts/probe/database', { method: 'POST', body: JSON.stringify({ operation: 'exec', sql: 'DROP TABLE accounts' }) })
  expect(response.status).toBe(404)
  for (const path of ['/__accounts/probe/events', '/__accounts/probe/measurement']) expect((await fixture.request(path)).status).toBe(404)
  expect(await fixture.db.prepare("SELECT name FROM sqlite_master WHERE name = 'accounts'").first('name')).toBe('accounts')
})
