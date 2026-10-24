import { expect, it } from 'vitest'
import { command, customer, direct, fixture, post, prepared } from '../sync/testing'
import { claimGenerationCleanup } from '../sync/storage'

it('cleanupCannotRaceLiveCommit', async () => {
  const f = await fixture(), owner = await customer(f), upload = await prepared(f, owner)
  const accepted = command([upload.descriptor])
  expect((await post(f, 'sync/commits', accepted, owner.headers)).status).toBe(200)
  const { context } = await direct(f, owner, 1_800_000_000_000 + 24 * 60 * 60_000)
  const generation = await f.db.prepare('SELECT generation FROM upload_reservations WHERE account_id = ?').bind(owner.accountId).first<string>('generation')
  expect(await claimGenerationCleanup(owner.accountId, generation!, context)).toBe(false)
  f.advance(24 * 60 * 60_000)
  await f.runJobs()
  expect((await f.objects.list()).objects[0].size).toBe(upload.bytes.length)
  expect(await f.db.prepare('SELECT state FROM storage_generations WHERE id = ?').bind(generation).first('state')).toBe('ready')
  expect(await f.db.prepare('SELECT state FROM publication_work WHERE mutation_id = ?').bind(accepted.mutationId).first('state')).toBe('accepted')
})
it('cleans expired unretained staging at quota capacity without changing a retained original', async () => {
  const f = await fixture(), owner = await customer(f), retained = await prepared(f, owner)
  expect((await post(f, 'sync/commits', command([retained.descriptor]), owner.headers)).status).toBe(200)
  const staging = await prepared(f, owner)
  await f.db.prepare('UPDATE accounts SET capacity_bytes = 1 WHERE id = ?').bind(owner.accountId).run()
  f.advance(24 * 60 * 60_000)
  await f.runJobs()
  const retainedGeneration = await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(retained.descriptor.uploadId).first<string>('generation')
  const stagingGeneration = await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(staging.descriptor.uploadId).first<string>('generation')
  expect(await f.db.prepare('SELECT state FROM storage_generations WHERE id = ?').bind(stagingGeneration).first('state')).toBe('closed')
  expect(await f.db.prepare('SELECT state FROM storage_generations WHERE id = ?').bind(retainedGeneration).first('state')).toBe('ready')
  expect((await f.objects.list()).objects.map(row => row.size).sort()).toEqual([32,33])
})
