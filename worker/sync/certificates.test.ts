import { expect, it } from 'vitest'
import { fixture, customer, prepared, post, command, direct, measuredDatabase, measurement, id } from './testing'
import { commitRevisions, reconcileExpiredPublicationWork } from './commit'
import { invalidateClosureCertificate } from './certificates'
import { claimGenerationCleanup, fenceGeneration } from './storage'

async function certificateFixture(memberRevision?: string) {
  const f = await fixture(), signed = await customer(f)
  const leaf = await prepared(f, signed)
  const member = await prepared(f, signed, { dependencies: [{ documentId: leaf.descriptor.documentId, revisionId: leaf.descriptor.revisionId }], ...(memberRevision ? { revisionId: memberRevision } : {}) })
  const head = await prepared(f, signed, { dependencies: [{ documentId: member.descriptor.documentId, revisionId: member.descriptor.revisionId }] })
  const source = command([leaf.descriptor, member.descriptor, head.descriptor], [{ documentId: head.descriptor.documentId, revisionId: head.descriptor.revisionId }])
  expect((await post(f, 'sync/commits', source, signed.headers)).status).toBe(200)
  const child = await prepared(f, signed, { dependencies: [{ documentId: member.descriptor.documentId, revisionId: member.descriptor.revisionId }] })
  const input = command([child.descriptor], [], [])
  return { f, signed, leaf, member, head, source, child, input, ...await direct(f, signed) }
}

it('headlessMemberBorrowsIntactProofButLaterHeadTraversesEveryDependency', async () => {
  const f = await fixture(), signed = await customer(f)
  const leaf = await prepared(f, signed)
  const member = await prepared(f, signed, { dependencies: [{ documentId: leaf.descriptor.documentId, revisionId: leaf.descriptor.revisionId }] })
  const head = await prepared(f, signed, { dependencies: [{ documentId: member.descriptor.documentId, revisionId: member.descriptor.revisionId }] })
  const source = command([leaf.descriptor, member.descriptor, head.descriptor], [{ documentId: head.descriptor.documentId, revisionId: head.descriptor.revisionId }])
  expect((await post(f, 'sync/commits', source, signed.headers)).status).toBe(200)
  const child = await prepared(f, signed, { dependencies: member.descriptor.dependencies.map(() => ({ documentId: member.descriptor.documentId, revisionId: member.descriptor.revisionId })) })
  const input = command([child.descriptor], [], [])
  const { principal, context } = await direct(f, signed), measured = measuredDatabase(f.db)
  const { commitRevisions } = await import('./commit')
  const diagnostic = new Proxy(measured.db, { get(target, key) {
    if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
      try { return await target.batch(...args) } catch (error) { console.info(String(error)); throw error }
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  const receipt = await commitRevisions(principal, input, { ...context, env: { ...context.env, DB: diagnostic } })
  const pins = await f.db.prepare('SELECT revision_id,done,generation FROM publication_pins WHERE mutation_id = ?').bind(input.mutationId).all()
  expect(pins.results).toHaveLength(2)
  const binding = await f.db.prepare('SELECT * FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first()
  expect(binding).toMatchObject({ source_mutation: source.mutationId, revision_id: member.descriptor.revisionId, document_id: member.descriptor.documentId })
  expect(await commitRevisions(principal, input, context)).toEqual(receipt)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(1)
  const publish = command([], [{ documentId: child.descriptor.documentId, revisionId: child.descriptor.revisionId }])
  expect((await post(f, 'sync/commits', publish, signed.headers)).status).toBe(200)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_pins WHERE mutation_id = ? AND done = 1 AND retained = 1').bind(publish.mutationId).first('n')).toBe(3)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ?').bind(publish.mutationId).first('n')).toBe(0)
  expect(await f.db.prepare('SELECT state FROM publication_certificates WHERE mutation_id = ?').bind(publish.mutationId).first('state')).toBe('intact')
  await measurement('headless-certificate', { ...measured.values, pins: pins.results.length })
})

it('validatingAndCompleteBorrowersFenceEverySourceOwnerUntilReceiptAndPartialRetirement', async () => {
  const { f, signed, leaf, member, head, source, input, principal, context } = await certificateFixture()
  const generation = await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(leaf.input.uploadId).first<string>('generation')
  await expect(commitRevisions(principal, input, { ...context, checkpoint(stage) { if (stage === 'sync.certificate.claimed') throw new Error('lost claim response') } })).rejects.toThrow('lost claim response')
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(1)
  const destructive = [
    ['publication_work', 'mutation_id', source.mutationId], ['publication_progress', 'mutation_id', source.mutationId],
    ['publication_pins', 'mutation_id', source.mutationId], ['mutation_receipts', 'mutation_id', source.mutationId],
    ['sync_revisions', 'revision_id', member.descriptor.revisionId], ['sync_dependencies', 'revision_id', member.descriptor.revisionId],
    ['upload_reservations', 'upload_id', member.input.uploadId], ['storage_generations', 'id', generation!], ['upload_chunks', 'generation', generation!],
  ]
  for (const phase of ['validating', 'complete']) {
    expect(await f.db.prepare('SELECT state FROM publication_work WHERE mutation_id = ?').bind(input.mutationId).first('state')).toBe(phase)
    expect(await invalidateClosureCertificate(signed.accountId, source.mutationId, context)).toBe(false)
    expect(await claimGenerationCleanup(signed.accountId, generation!, { ...context, now: () => context.now() + 86_400_001 })).toBe(false)
    for (const [table, field, value] of destructive) await expect(f.db.prepare(`DELETE FROM ${table} WHERE ${field} = ?`).bind(value).run()).rejects.toThrow('certificate_lifetime')
    await expect(f.db.prepare('DELETE FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).run()).rejects.toThrow('certificate_lifetime')
    await expect(f.db.prepare('DELETE FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).run()).rejects.toThrow('certificate_lifetime')
    for (const [field, value] of [['generation', id()], ['document_id', id()], ['done', 0], ['retained', 1]] as const) await expect(f.db.prepare(`UPDATE publication_pins SET ${field} = ? WHERE mutation_id = ? AND revision_id = ?`).bind(value, input.mutationId, member.descriptor.revisionId).run()).rejects.toThrow('certificate_lifetime')
    await expect(f.db.prepare('UPDATE publication_borrows SET source_work = ? WHERE mutation_id = ?').bind(id(), input.mutationId).run()).rejects.toThrow('certificate_binding_immutable')
    await expect(f.db.prepare('UPDATE publication_progress SET work_id = ? WHERE mutation_id = ?').bind(id(), input.mutationId).run()).rejects.toThrow('certificate_lifetime')
    const binding = await f.db.prepare('SELECT * FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first()
    const progress = await f.db.prepare('SELECT * FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first()
    await f.db.prepare('UPDATE publication_pins SET done = done,generation = generation,retained = retained WHERE mutation_id = ? AND revision_id = ?').bind(input.mutationId, member.descriptor.revisionId).run()
    expect(await f.db.prepare('SELECT * FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first()).toEqual(binding)
    expect(await f.db.prepare('SELECT * FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first()).toEqual(progress)
    if (phase === 'validating') await expect(commitRevisions(principal, input, { ...context, checkpoint(stage) { if (stage === 'sync.commit.before') throw new Error('lost final attempt') } })).rejects.toThrow('lost final attempt')
  }
  const receipt = await commitRevisions(principal, input, context)
  expect(await invalidateClosureCertificate(signed.accountId, source.mutationId, context)).toBe(true)
  await f.db.prepare('DELETE FROM publication_pins WHERE mutation_id = ? AND revision_id = ?').bind(source.mutationId, leaf.descriptor.revisionId).run()
  expect(await f.db.prepare('SELECT done,retained FROM publication_pins WHERE mutation_id = ? AND revision_id = ?').bind(source.mutationId, member.descriptor.revisionId).first()).toEqual({ done: 1, retained: 1 })
  const next = await prepared(f, signed, { dependencies: [{ documentId: member.descriptor.documentId, revisionId: member.descriptor.revisionId }] })
  const fallback = command([next.descriptor], [], [])
  await commitRevisions(principal, fallback, context)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_pins WHERE mutation_id = ?').bind(fallback.mutationId).first('n')).toBe(3)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ?').bind(fallback.mutationId).first('n')).toBe(0)
  // A surviving member never launders the missing descendant after partial retirement
  expect(await claimGenerationCleanup(signed.accountId, generation!, { ...context, now: () => context.now() + 86_400_001 })).toBe(true)
  expect(await fenceGeneration(generation!, context)).toBe(true)
  const blocked = command([], [{ documentId: head.descriptor.documentId, revisionId: head.descriptor.revisionId }], [{ documentId: head.descriptor.documentId, revisionId: head.descriptor.revisionId }])
  await expect(commitRevisions(principal, blocked, context)).rejects.toThrow()
  expect(await commitRevisions(principal, input, context)).toEqual(receipt)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_certificates WHERE state = ?').bind('intact').first('n')).toBe(0)
})

it('retirementWinningAfterLookupCannotBecomeAnUnprovedClaim', async () => {
  const { f, signed, source, input, principal, context } = await certificateFixture()
  let paused = false
  const db = new Proxy(f.db, { get(target, key) {
    if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
      if (paused) {
        paused = false
        await target.prepare("UPDATE publication_work SET state = 'abandoned' WHERE mutation_id = ?").bind(input.mutationId).run()
        expect(await invalidateClosureCertificate(signed.accountId, source.mutationId, context)).toBe(true)
      }
      return target.batch(...args)
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  await expect(commitRevisions(principal, input, { ...context, env: { ...context.env, DB: db }, checkpoint(stage) { if (stage === 'sync.certificate.candidate') paused = true } })).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(0)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM mutation_receipts WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(0)
  await commitRevisions(principal, input, context)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_pins WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(3)
})

it.each(['legacy-marker', 'legacy-progress', 'missing-receipt', 'digest', 'incarnation', 'head-document', 'head-revision', 'head-generation', 'foreign-account', 'member-document', 'member-generation', 'member-not-retained', 'member-not-done', 'unaccepted', 'multi-head', 'inherited'])(
  'ineligibleCertificateFallsBackToFullTraversal: %s', async variant => {
    const { f, signed, source, member, head, input, principal, context } = await certificateFixture()
    const original = (await f.db.prepare('SELECT * FROM publication_certificates WHERE mutation_id = ?').bind(source.mutationId).first())!
    expect(await invalidateClosureCertificate(signed.accountId, source.mutationId, context)).toBe(true)
    await f.db.prepare('DELETE FROM publication_certificates WHERE mutation_id = ?').bind(source.mutationId).run()
    const fields = ['account_id', 'mutation_id', 'digest', 'work_id', 'head_document', 'head_revision', 'head_generation', 'version', 'state']
    const altered: Record<string, unknown> = { ...original, state: 'intact' }
    const property: Record<string, string> = { digest: 'digest', incarnation: 'work_id', 'head-document': 'head_document', 'head-revision': 'head_revision', 'head-generation': 'head_generation', 'foreign-account': 'account_id' }
    if (property[variant]) altered[property[variant]] = id()
    if (variant === 'legacy-progress') await f.db.prepare('DELETE FROM publication_progress WHERE mutation_id = ?').bind(source.mutationId).run()
    if (variant === 'missing-receipt') await f.db.prepare('DELETE FROM mutation_receipts WHERE mutation_id = ?').bind(source.mutationId).run()
    if (variant === 'unaccepted') await f.db.prepare("UPDATE publication_work SET state = 'abandoned' WHERE mutation_id = ?").bind(source.mutationId).run()
    const memberProperty: Record<string, string> = { 'member-document': 'document_id', 'member-generation': 'generation', 'member-not-retained': 'retained', 'member-not-done': 'done' }
    if (memberProperty[variant]) await f.db.prepare(`UPDATE publication_pins SET ${memberProperty[variant]} = ? WHERE mutation_id = ? AND revision_id = ?`).bind(variant.endsWith('retained') || variant.endsWith('done') ? 0 : id(), source.mutationId, member.descriptor.revisionId).run()
    if (variant === 'multi-head') await f.db.prepare("UPDATE mutation_receipts SET receipt = json_set(receipt,'$.heads',json(?)) WHERE mutation_id = ?").bind(JSON.stringify([head.descriptor, member.descriptor].map(({ documentId, revisionId }) => ({ documentId, revisionId }))), source.mutationId).run()
    if (variant === 'inherited') await f.db.prepare(`INSERT INTO publication_borrows(account_id,mutation_id,work_id,digest,revision_id,document_id,generation,source_mutation,source_digest,source_work,source_head_document,source_head_revision,source_head_generation)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(signed.accountId, source.mutationId, original.work_id, original.digest, head.descriptor.revisionId, head.descriptor.documentId, original.head_generation, id(), id(), id(), id(), id(), id()).run()
    // Simulate contradictory persisted evidence independently of admission; no client can author these rows
    if (variant !== 'legacy-marker') await f.db.prepare(`INSERT INTO publication_certificates(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).bind(...fields.map(field => altered[field])).run()
    await commitRevisions(principal, input, context)
    expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_pins WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(3)
    const borrows = (await f.db.prepare('SELECT revision_id FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).all()).results
    expect(borrows.some(row => row.revision_id === member.descriptor.revisionId)).toBe(false)
    expect(borrows).toHaveLength(memberProperty[variant] ? 1 : 0)
  },
)

it('claimQuotaRollbackAndDuplicateLostResponsesChargeOnlyActualTransitions', async () => {
  const { f, input, principal, context } = await certificateFixture()
  const env = { ...context.env }, totals = () => f.db.prepare("SELECT metadata_bytes,metadata_rows,edges FROM quota_counters WHERE scope = 'global'").first()
  let before: Awaited<ReturnType<typeof totals>>
  const db = new Proxy(f.db, { get(target, key) {
    if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
      if (env.STORAGE_CAP_BYTES === '1') before = await totals()
      return target.batch(...args)
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  env.DB = db
  await expect(commitRevisions(principal, input, { ...context, env, checkpoint(stage) { if (stage === 'sync.certificate.candidate') env.STORAGE_CAP_BYTES = '1' } })).rejects.toThrow('QUOTA_EXCEEDED')
  expect(await totals()).toEqual(before!)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(0)
  expect(await f.db.prepare('SELECT processed_steps FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('processed_steps')).toBe(1)
  const repeated = await Promise.allSettled([commitRevisions(principal, input, context), commitRevisions(principal, input, context)])
  expect(repeated.some(value => value.status === 'fulfilled')).toBe(true)
  const receipt = await commitRevisions(principal, input, context), settled = await totals()
  expect(await commitRevisions(principal, input, { ...context, checkpoint() { throw new Error('Receipt replay must not create proof') } })).toEqual(receipt)
  expect(await totals()).toEqual(settled)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(1)
  expect(await f.db.prepare('SELECT processed_steps FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('processed_steps')).toBe(2)
})

it('delayedExpiryScanDoesNotAbandonAReplacementIncarnation', async () => {
  const { f, input, principal, context } = await certificateFixture()
  const stopAfterClaim = (stage: string) => { if (stage === 'sync.certificate.claimed') throw new Error('paused claim') }
  await expect(commitRevisions(principal, input, { ...context, checkpoint: stopAfterClaim })).rejects.toThrow('paused claim')
  const old = await f.db.prepare('SELECT work_id FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('work_id')
  const future = { ...context, now: () => context.now() + 86_400_001 }
  let selected = false
  const db = new Proxy(f.db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      const statement = target.prepare(sql)
      if (!sql.startsWith('DELETE FROM scan_leases')) return statement
      const wrap = (value: typeof statement): typeof statement => new Proxy(value, { get(statement, field) {
        if (field === 'bind') return (...args: Parameters<typeof statement.bind>) => wrap(statement.bind(...args))
        if (field === 'run') return async () => {
          if (selected) {
            selected = false
            await target.prepare("UPDATE publication_work SET state = 'abandoned' WHERE mutation_id = ?").bind(input.mutationId).run()
            await expect(commitRevisions(principal, input, { ...future, checkpoint: stopAfterClaim })).rejects.toThrow('paused claim')
          }
          return statement.run()
        }
        const result = Reflect.get(statement, field); return typeof result === 'function' ? result.bind(statement) : result
      } })
      return wrap(statement)
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  expect(await reconcileExpiredPublicationWork({ ...future, env: { ...future.env, DB: db }, checkpoint(stage) { if (stage === 'sync.expiry.selected') selected = true } })).toBe(0)
  const current = await f.db.prepare('SELECT w.state,w.expires_at,p.work_id FROM publication_work w JOIN publication_progress p USING(account_id,mutation_id) WHERE w.mutation_id = ?').bind(input.mutationId).first()
  expect(current).toMatchObject({ state: 'validating', expires_at: future.now() + 86_400_000 })
  expect(current!.work_id).not.toBe(old)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ? AND work_id = ?').bind(input.mutationId, old).first('n')).toBe(0)
  await commitRevisions(principal, input, future)
})

it('staleFinalCallerCannotFinalizeReplacementCompletedWork', async () => {
  const { f, input, principal, context } = await certificateFixture()
  let replace = false, old: unknown, replacement: unknown
  const db = new Proxy(f.db, { get(target, key) {
    if (key === 'batch') return async (...args: Parameters<typeof target.batch>) => {
      if (replace) {
        replace = false
        old = await target.prepare('SELECT work_id FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('work_id')
        await target.prepare("UPDATE publication_work SET state = 'abandoned' WHERE mutation_id = ?").bind(input.mutationId).run()
        await expect(commitRevisions(principal, input, { ...context, checkpoint(stage) { if (stage === 'sync.commit.before') throw new Error('replacement complete') } })).rejects.toThrow('replacement complete')
        replacement = await target.prepare('SELECT work_id FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('work_id')
      }
      return target.batch(...args)
    }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } })
  await expect(commitRevisions(principal, input, { ...context, env: { ...context.env, DB: db }, checkpoint(stage) { if (stage === 'sync.commit.before') replace = true } })).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(replacement).not.toBe(old)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM mutation_receipts WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(0)
  expect(await f.db.prepare('SELECT state FROM publication_work WHERE mutation_id = ?').bind(input.mutationId).first('state')).toBe('complete')
  await expect(commitRevisions(principal, input, { ...context, checkpoint(stage) { if (stage === 'sync.commit.after') throw new Error('lost accepted response') } })).rejects.toThrow('lost accepted response')
  expect((await commitRevisions(principal, input, context)).mutationId).toBe(input.mutationId)
})

it('restartDrainsOldBindingsInBoundedPagesBeforeFreshProofAndPreservesCharges', async () => {
  const f = await fixture(), signed = await customer(f), leaves = []
  for (let index = 0; index < 50; index++) leaves.push((await prepared(f, signed)).descriptor)
  for (let index = 0; index < leaves.length; index += 32) expect((await post(f, 'sync/commits', command(leaves.slice(index, index + 32), [], []), signed.headers)).status).toBe(200)
  const source = await prepared(f, signed, { dependencies: leaves.map(({ documentId, revisionId }) => ({ documentId, revisionId })) })
  const publish = command([source.descriptor]), { principal, context } = await direct(f, signed)
  await expect(commitRevisions(principal, publish, context)).rejects.toThrow('SERVICE_UNAVAILABLE')
  await commitRevisions(principal, publish, context)
  const child = await prepared(f, signed, { dependencies: source.descriptor.dependencies }), input = command([child.descriptor], [], [])
  await expect(commitRevisions(principal, input, context)).rejects.toThrow('SERVICE_UNAVAILABLE')
  await expect(commitRevisions(principal, input, { ...context, checkpoint(stage) { if (stage === 'sync.commit.before') throw new Error('complete unpublished') } })).rejects.toThrow('complete unpublished')
  const old = await f.db.prepare('SELECT work_id FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('work_id')
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(50)
  const future = { ...context, now: () => context.now() + 86_400_001 }
  expect(await reconcileExpiredPublicationWork(future)).toBe(1)
  const cost = () => f.db.prepare(`SELECT COALESCE((SELECT SUM(metadata_bytes) FROM publication_pins WHERE mutation_id = ?),0)
    + COALESCE((SELECT SUM(metadata_bytes) FROM publication_borrows WHERE mutation_id = ?),0) AS bytes`).bind(input.mutationId, input.mutationId).first<number>('bytes')
  const beforeCost = await cost(), beforeGlobal = await f.db.prepare("SELECT metadata_bytes FROM quota_counters WHERE scope = 'global'").first<number>('metadata_bytes')
  await expect(commitRevisions(principal, input, future)).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_pins WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(3)
  expect(await f.db.prepare('SELECT work_id FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('work_id')).toBe(old)
  expect(await f.db.prepare("SELECT metadata_bytes FROM quota_counters WHERE scope = 'global'").first('metadata_bytes')).toBe(beforeGlobal! - beforeCost! + (await cost())!)
  await expect(commitRevisions(principal, input, future)).rejects.toThrow('SERVICE_UNAVAILABLE')
  expect(await f.db.prepare('SELECT work_id FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('work_id')).not.toBe(old)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ? AND work_id = ?').bind(input.mutationId, old).first('n')).toBe(0)
  await commitRevisions(principal, input, future)
  expect(await f.db.prepare('SELECT processed_steps FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('processed_steps')).toBe(51)
}, 30_000)

it('revivedGenerationNeedsFreshConcreteProofAndDoesNotReactivateRetiredSource', async () => {
  const { f, signed, source, member, input, principal, context } = await certificateFixture()
  const old = await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(member.input.uploadId).first('generation')
  expect(await invalidateClosureCertificate(signed.accountId, source.mutationId, context)).toBe(true)
  await f.db.prepare('DELETE FROM publication_pins WHERE mutation_id = ? AND revision_id = ?').bind(source.mutationId, member.descriptor.revisionId).run()
  expect(await claimGenerationCleanup(signed.accountId, old as string, { ...context, now: () => context.now() + 86_400_001 })).toBe(true)
  expect(await fenceGeneration(old as string, context)).toBe(true)
  expect((await post(f, 'sync/uploads', member.input, signed.headers)).status).toBe(200)
  expect((await f.request(`/api/v1/sync/uploads/${member.input.uploadId}/chunks/0`, { method: 'PUT', headers: { origin: 'http://127.0.0.1', 'content-type': 'application/octet-stream', ...signed.headers }, body: member.bytes })).status).toBe(200)
  expect((await post(f, `sync/uploads/${member.input.uploadId}/finish`, { version: 1 }, signed.headers)).status).toBe(200)
  const current = await f.db.prepare('SELECT generation FROM upload_reservations WHERE upload_id = ?').bind(member.input.uploadId).first('generation')
  expect(current).not.toBe(old)
  await commitRevisions(principal, input, context)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_pins WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(3)
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE source_mutation = ?').bind(source.mutationId).first('n')).toBe(0)
  const publish = command([], [{ documentId: member.descriptor.documentId, revisionId: member.descriptor.revisionId }])
  await commitRevisions(principal, publish, context)
  expect(await f.db.prepare('SELECT head_generation,state FROM publication_certificates WHERE mutation_id = ?').bind(publish.mutationId).first()).toEqual({ head_generation: current, state: 'intact' })
  expect(await f.db.prepare('SELECT state FROM publication_certificates WHERE mutation_id = ?').bind(source.mutationId).first('state')).toBe('invalidated')
})

it.each(['before', 'after'])('diamondRegistrationPreservesBorrowedMemberWithRediscovery: %s', async ordering => {
  const { f, signed, member, principal, context } = await certificateFixture('MMMMMMMMMMMMMMMMMMMMMA')
  const dependencies = [{ documentId: member.descriptor.documentId, revisionId: member.descriptor.revisionId }]
  const first = await prepared(f, signed, { dependencies, revisionId: 'AAAAAAAAAAAAAAAAAAAAAA' })
  const last = await prepared(f, signed, { dependencies, revisionId: ordering === 'after' ? 'zzzzzzzzzzzzzzzzzzzzzw' : 'BBBBBBBBBBBBBBBBBBBBBA' })
  const input = command([first.descriptor, last.descriptor], [], [])
  await expect(commitRevisions(principal, input, context)).resolves.toMatchObject({ mutationId: input.mutationId })
  expect(await f.db.prepare('SELECT COUNT(*) n FROM publication_borrows WHERE mutation_id = ?').bind(input.mutationId).first('n')).toBe(1)
  expect(await f.db.prepare('SELECT processed_steps FROM publication_progress WHERE mutation_id = ?').bind(input.mutationId).first('processed_steps')).toBe(3)
})
