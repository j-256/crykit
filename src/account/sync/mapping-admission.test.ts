import { expect, it } from 'vitest'
import { editorClosureFixture } from '../../workspace/test-helpers'
import { admitFirstAllocationComparison } from './mapping-admission'
import type { RemoteProjection } from './projection'
import type { OpenAccountWorkspace } from '../../workspace/account-graph'
import type { AccountDatabase } from '../../persistence/account-database'
import type { ProfileToken } from '../profile'
import type { MappedWorkspaceChange } from '../../workspace/account-intents'

it.each(['update', 'delete', 'replace', 'mixed', 'baseline-present', 'unit-present', 'lineage-present'] as const)('externalBulkAdmissionRejectsIneligibleIntent %s', async variant => {
  const fixture = await editorClosureFixture(), key = '["editor","editor-1"]', ref = { documentId: 'AAAAAAAAAAAAAAAAAAAAAA', revisionId: 'BBBBBBBBBBBBBBBBBBBBBA' }
  const target = { state: { ...fixture.state, editorDocuments: [fixture.file] } } as unknown as OpenAccountWorkspace
  const changes: MappedWorkspaceChange[] = [{ key, kind: 'editor', before: null, after: ref }]
  if (variant === 'update') changes[0].before = ref
  if (variant === 'delete') changes[0] = { key, kind: 'tombstone', before: ref, after: null }
  if (variant === 'mixed') changes.push({ key: '["editor","other"]', kind: 'tombstone', before: ref, after: null })
  const base = { units: new Map(variant === 'unit-present' ? [[key, {}]] : []), lineages: new Map(variant === 'lineage-present' ? [[key, {}]] : []), baseline: variant === 'baseline-present' ? [{ kind: 'mutable', key, seed: ref, replacedHead: null }] : [] } as unknown as RemoteProjection
  // Ineligible intents must reject before reading any live authority or mutating persistence
  const db = new Proxy({}, { get() { throw new Error('Unexpected database access') } }) as AccountDatabase
  await expect(admitFirstAllocationComparison(db, {} as ProfileToken, base, {} as RemoteProjection, target, changes, variant === 'replace' ? 'replace' : 'additive')).resolves.toBe(false)
})
