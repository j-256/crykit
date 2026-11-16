import assert from 'node:assert/strict'
import { test } from 'vitest'
import { originalPublicationBodies } from '../../e2e/accounts/signin-originals-publication'

const body = (name: string) => ({ ref: { documentId: name, revisionId: '1', byteLength: 4, sha256: `hash-${name}`, encoding: 'utf8' }, digest: `hash-${name}` })
const original = body('original'), root = body('root'), index = body('index')
const fixture = () => ({ bodies: [original, root, index], bodyRoles: { historicalMembers: [] as { nativeRefs: typeof original.ref[]; catalogRefs: typeof original.ref[] }[], currentNativeRefs: [original.ref, root.ref, index.ref], publishableNativeRefs: [original.ref], requiredRefs: [original.ref], pendingTargets: [{ kind: 'pending-content', unit: { privateKey: '["save","fixture"]' }, root: root.ref, index: index.ref }] } })

test('permits only exact pending target wrappers while preserving eligible originals', () => {
  assert.deepEqual(originalPublicationBodies(fixture()), { published: [original], omitted: [root, index] })
})
test('rejects a projection that hides an original or a shared conflict body', () => {
  const value = fixture(); value.bodyRoles.requiredRefs.push(root.ref)
  assert.throws(() => originalPublicationBodies(value), /required original or conflict/)
})
test('rejects unclassified pending descendants and changed full ref associations', () => {
  const value = fixture(), descendant = body('descendant')
  value.bodies.push(descendant); value.bodyRoles.currentNativeRefs.push(descendant.ref)
  assert.throws(() => originalPublicationBodies(value), /Unclassified/)
  const changed = fixture(); changed.bodyRoles.pendingTargets[0].root = { ...root.ref, sha256: 'different' }
  assert.throws(() => originalPublicationBodies(changed), /Unclassified/)
})
test('rejects missing required bodies, foreign publication membership, and corrupt hashes', () => {
  const missing = fixture(); missing.bodies.shift()
  assert.throws(() => originalPublicationBodies(missing), /Missing original role/)
  const foreign = fixture(); foreign.bodyRoles.publishableNativeRefs.push(body('foreign').ref)
  assert.throws(() => originalPublicationBodies(foreign), /Foreign publication/)
  const corrupt = fixture(); corrupt.bodies[0] = { ...original, digest: 'different' }
  assert.throws(() => originalPublicationBodies(corrupt), /hash mismatch/)
})

test('preserves a pending target also required by an admitted historical member in either body role', () => {
  const value = fixture()
  value.bodyRoles.historicalMembers.push({ nativeRefs: [root.ref], catalogRefs: [index.ref] })
  assert.deepEqual(originalPublicationBodies(value), { published: [original, root, index], omitted: [] })
  value.bodyRoles.historicalMembers[0].nativeRefs = [{ ...root.ref, encoding: 'bytes' }]
  assert.throws(() => originalPublicationBodies(value), /Missing original role/)
})
