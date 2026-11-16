import { accountLocalId } from './account-cache'
import { expect, it } from 'vitest'
import { IncrementalWorkspaceIntentSchema, IncrementalMappingReceiptSchema } from './account-mapping-origin'

const ref = { documentId: accountLocalId(), revisionId: accountLocalId() }
const intent = { version: 1, kind: 'incremental-workspace-intent', operationId: accountLocalId(), mode: 'additive', operation: 'workspace-command', sequence: 1, before: ref, after: ref }

it('retains exact V1 intent semantics and separately admits required V2 comparisons', () => {
  expect(IncrementalWorkspaceIntentSchema.parse(intent)).toEqual(intent)
  expect(IncrementalWorkspaceIntentSchema.safeParse({ ...intent, copiedComparisons: ref }).success).toBe(false)
  const next = { ...intent, version: 2, copiedComparisons: ref }
  expect(IncrementalWorkspaceIntentSchema.parse(next)).toEqual(next)
  expect(IncrementalWorkspaceIntentSchema.safeParse({ ...intent, version: 2 }).success).toBe(false)
  expect(IncrementalWorkspaceIntentSchema.safeParse({ ...next, mode: 'replace' }).success).toBe(false)
  expect(IncrementalWorkspaceIntentSchema.safeParse({ ...next, version: 3 }).success).toBe(false)
  for (const value of [intent, next]) {
    const receipt = { version: 1, kind: 'incremental-mapping-receipt', accountId: accountLocalId(), original: { id: intent.operationId, ref, status: 'unmapped-local' }, intent: value, base: ref, target: ref, mappedIntent: ref }
    expect(IncrementalMappingReceiptSchema.parse(receipt)).toEqual(receipt)
  }
})

it('keeps comparison writes disabled without the explicit qualification build', async () => {
  expect((await import('./managed-copy-comparisons')).managedComparisonWritesEnabled()).toBe(false)
})

it('rejects unknown fields and duplicate sidecar associations without reinterpreting V1', async () => {
  const { ManagedCopyComparisonsSchema } = await import('./managed-copy-comparisons')
  const sidecar = { version: 1, kind: 'managed-copy-comparisons', operationId: intent.operationId, mode: 'additive', source: ref, sourceEvidence: ref, sourceIdentity: 'a'.repeat(64), sourceDigest: 'b'.repeat(64), destination: { key: 'active', headRevision: 0, head: ref }, destinationEvidence: ref, keys: ['["editor","file"]'], progressMappings: [], originals: [] }
  expect(ManagedCopyComparisonsSchema.parse(sidecar)).toEqual(sidecar)
  const compact = { ...sidecar, version: 2, sourceFormat: 'compact-v2' }
  expect(ManagedCopyComparisonsSchema.parse(compact)).toEqual(compact)
  for (const value of [{ ...sidecar, sourceFormat: 'compact-v2' }, { ...compact, sourceFormat: 'legacy-v1' }, { ...compact, version: 3 }]) expect(ManagedCopyComparisonsSchema.safeParse(value).success).toBe(false)
  for (const altered of [{ ...sidecar, version: 2 }, { ...sidecar, mode: 'replace' }, { ...sidecar, currentState: {} }, { ...sidecar, keys: [...sidecar.keys, ...sidecar.keys] }, { ...sidecar, sourceDigest: 'incomplete' }]) expect(ManagedCopyComparisonsSchema.safeParse(altered).success).toBe(false)
})

it('does not mint or accept caller-manufactured original mapping authority', async () => {
  const { managedComparisonMappingBinding, proveManagedComparisonMapping } = await import('./managed-copy-comparisons')
  await expect(managedComparisonMappingBinding({ kind: 'managed-comparison-mapping' }, {} as never, {} as never)).rejects.toThrow('Foreign managed comparison proof')
  await expect(proveManagedComparisonMapping({} as never, {} as never, {} as never, {} as never, {} as never, {} as never)).rejects.toThrow('Foreign managed comparison admission')
})
