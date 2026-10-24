import { expect, it, vi } from 'vitest'
import { modCatalogRevision } from '../domain/mod-layers'
import { createTestLocalData } from '../domain/test-helpers'
import { createBlankLocalData } from '../domain/local-data'
import { historyEntry } from '../persistence/local-data'
import * as localValidation from '../persistence/local-data'
import { NativeHistorySchema } from '../interchange/native-schema'
import { immutableCatalogSnapshot } from '../interchange/native'
import type { CatalogSnapshot } from '../domain/types'
import { immutableHistory, immutableHistoryEndpoint, parseImmutableHistory, validateHistoryEndpoint } from './history-admission'
import { domainClosureKeys, resolvedDomainClosureKeys } from './domain-closure'
import { privateRecordKey, type WorkspaceDocument } from './documents'

function checkpoint() {
  const before = createBlankLocalData()
  return historyEntry(before, { ...before, revision: 1 }, 'history-admission', before.updatedAt)
}
function catalog(id: string): CatalogSnapshot {
  return { id, revisionId: 'exact', schemaVersion: 'synthetic', checksum: id, importedAt: '2026-01-01T00:00:00.000Z', applicability: { state: 'unknown' }, rights: { state: 'unknown' }, entities: {}, claims: [] } as unknown as CatalogSnapshot
}

it('admits complete raw shapes and retains exact compact endpoint identity without another full history parse', () => {
  const input = checkpoint(), expected = structuredClone(input)
  const parsed = parseImmutableHistory(input)
  expect(parsed).toEqual(NativeHistorySchema.parse(expected))
  expect(parsed).not.toBe(input)
  const before = immutableHistoryEndpoint(parsed.before), after = immutableHistoryEndpoint(parsed.after)
  const parse = vi.spyOn(NativeHistorySchema, 'parse')
  try {
    const compact = immutableHistory({ ...parsed, before, after })
    expect(compact.before).toBe(before); expect(compact.after).toBe(after)
    expect(immutableHistory(compact)).toBe(compact)
    expect(parse).not.toHaveBeenCalled()
    expect(() => { (compact.after as unknown as { revision: number }).revision = 99 }).toThrow()
    expect(() => immutableHistory({ ...compact, unexpected: true } as never)).toThrow()
  } finally { parse.mockRestore() }
  const changed = structuredClone(expected)
  ;(changed.after as unknown as { revision: unknown }).revision = 'invalid'
  expect(() => immutableHistory(changed)).toThrow()
  expect(() => immutableHistory(Object.freeze(changed))).toThrow()
  expect(input).toEqual(expected)
  const legacy = structuredClone(expected)
  for (const root of [legacy.before, legacy.after]) {
    const stored = root as unknown as Record<string, unknown>
    stored.schemaVersion = '2.3.0'; delete stored.teamRevisions
  }
  expect(parseImmutableHistory(legacy)).toEqual(NativeHistorySchema.parse(legacy))
  expect(legacy.before.schemaVersion).toBe('2.3.0')
})

it('revalidates changed ordered catalog contexts and never trusts mutable or shallow-frozen inputs', () => {
  const endpoint = immutableHistoryEndpoint(createBlankLocalData())
  const first = immutableCatalogSnapshot(catalog('first')), second = immutableCatalogSnapshot(catalog('second'))
  const ordered = Object.freeze([first, second]), reversed = Object.freeze([second, first])
  const validate = vi.spyOn(localValidation, 'validateLocalDataForStorage')
  try {
    validateHistoryEndpoint(endpoint, ordered); validateHistoryEndpoint(endpoint, ordered)
    expect(validate).toHaveBeenCalledTimes(1)
    validateHistoryEndpoint(endpoint, reversed)
    expect(validate).toHaveBeenCalledTimes(2)
    const replacement = Object.freeze([immutableCatalogSnapshot(catalog('first')), second])
    validateHistoryEndpoint(endpoint, replacement)
    expect(validate).toHaveBeenCalledTimes(3)
    const mutable = [first, second]
    validateHistoryEndpoint(endpoint, mutable); validateHistoryEndpoint(endpoint, mutable)
    expect(validate).toHaveBeenCalledTimes(5)
    const shallow = Object.freeze(catalog('shallow'))
    validateHistoryEndpoint(endpoint, Object.freeze([shallow]))
    ;(shallow.entities as Record<string, unknown>).invalid = { id: 'invalid' }
    expect(() => validateHistoryEndpoint(endpoint, Object.freeze([shallow]))).toThrow()
    const unknown = Object.freeze({ ...endpoint, revision: -1 })
    expect(() => validateHistoryEndpoint(unknown, ordered)).toThrow()
    const base = Object.values(createTestLocalData().gameSetups)[0]!
    const pinned = immutableHistoryEndpoint({ ...createBlankLocalData(), gameSetups: { [base.id]: { ...base, catalogLock: { [first.id]: first.revisionId } } } })
    const beforePin = validate.mock.calls.length
    validateHistoryEndpoint(pinned, ordered); validateHistoryEndpoint(pinned, ordered)
    expect(validate.mock.calls.length - beforePin).toBe(1)
    expect(() => validateHistoryEndpoint(pinned, Object.freeze([second]))).toThrow()
    const wrongPin = immutableCatalogSnapshot({ ...catalog('first'), revisionId: 'another' as CatalogSnapshot['revisionId'] })
    expect(() => validateHistoryEndpoint(pinned, Object.freeze([wrongPin, second]))).toThrow()
  } finally { validate.mockRestore() }
})

it('reuses only intrinsic history edge keys and checks changed actual dependency maps', () => {
  const input = checkpoint()
  const base = Object.values(createTestLocalData().gameSetups)[0]!
  const setupId = base.id, sourceId = 'baseline'
  const checksum = `sha256:${'a'.repeat(64)}`
  const receipt = { catalogId: 'crystal-edit:missing', catalogRevisionId: `${checksum}:rules-v1:library-v1`, checksum, title: 'Recorded source' }
  const setup = { ...base, catalogLock: { [sourceId]: modCatalogRevision(base.id) }, modComposition: { baseline: { catalogId: sourceId, catalogRevisionId: 'one' }, layers: [{ catalogId: receipt.catalogId, catalogRevisionId: receipt.catalogRevisionId, enabled: true }], links: [] }, modSourceReceipts: [receipt] }
  const value = immutableHistory({ ...input, before: { ...input.before, gameSetups: { [setupId]: setup } }, after: { ...input.after, gameSetups: { [setupId]: setup } } } as unknown as typeof input)
  const key = privateRecordKey('history', value.id), document = { version: 1, kind: 'history', key, value } as unknown as WorkspaceDocument
  const keys = domainClosureKeys('history', value)
  expect(domainClosureKeys('history', value)).toBe(keys)
  const required = privateRecordKey('catalog', sourceId, 'one')
  const baseline = { version: 1, kind: 'catalog', key: required, value: { ...catalog(sourceId), revisionId: 'one' } } as unknown as WorkspaceDocument
  const documents = new Map([[key, document], [baseline.key, baseline]])
  expect(resolvedDomainClosureKeys(document, documents)).toContain(required)
  const wrong = { version: 1, kind: 'catalog', key: privateRecordKey('catalog', receipt.catalogId, receipt.catalogRevisionId), value: { ...catalog(receipt.catalogId), revisionId: receipt.catalogRevisionId, checksum: 'wrong' } } as unknown as WorkspaceDocument
  expect(() => resolvedDomainClosureKeys(document, new Map(documents).set(wrong.key, wrong))).toThrow('checksum')
  expect(() => resolvedDomainClosureKeys({ ...document, key: privateRecordKey('history', 'another') }, documents)).toThrow()
})
