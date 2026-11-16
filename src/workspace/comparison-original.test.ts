import { afterEach, expect, it, vi } from 'vitest'
import { GUIDE_CATALOG } from '../catalog/bundled'
import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'
import { compactHistoricalIdentity, historicalSourceIdentity } from '../interchange/workspace-backup-catalog'
import { metadataSource, readBackupMetadata } from '../interchange/workspace-backup-evidence'
import { capturedCopyOriginal, guestEvidenceForCopy, guestEvidenceSources } from './guest-evidence'
import { comparisonOriginal } from './comparison-original'
import { captureCompactCatalogSnapshot } from './catalog-capture'
import { ownWorkspaceSnapshot } from './snapshot'
import { now, progress } from './signin-merge.test-helpers'

afterEach(() => vi.unstubAllGlobals())
async function fixture() {
  vi.stubGlobal('__CRYKIT_COMPACT_CATALOG_QUALIFICATION__', true)
  let live = true
  const state = progress('local', false)
  const source = ownWorkspaceSnapshot({ version: 1, dataGeneration: LAUNCH_DATA_GENERATION, snapshotId: 'original', capturedAt: now, revisionVector: {}, state: { ...state, planner: { ...state.planner, catalogs: [GUIDE_CATALOG] } } }, { async check() { if (!live) throw new Error('Released original') }, async dispose() { live = false } })
  const snapshot = await captureCompactCatalogSnapshot(source), current = await capturedCopyOriginal(snapshot)
  const sources = guestEvidenceSources(await guestEvidenceForCopy(snapshot))
  const identity = await historicalSourceIdentity(current.format, current.metadata)
  const binding = { sourceFormat: current.format, sourceIdentity: identity.id, sourceDigest: identity.metadataStreamDigest }
  return { source, snapshot, sources, current, binding, revoke() { live = false } }
}

it('binds the exact flat compact stream and ordered role-separated subsets', async () => {
  const f = await fixture(), retained = await comparisonOriginal(f.sources, f.binding)
  expect(retained.raw.version).toBe(3)
  expect(f.binding.sourceIdentity).toBe(await compactHistoricalIdentity(f.current.metadata))
  expect(retained.member.id).toBe(f.current.id)
  expect(retained.catalogBodies.length).toBeGreaterThan(0)
  expect(await historicalSourceIdentity('legacy-v1', f.current.metadata)).not.toEqual(await historicalSourceIdentity('compact-v2', f.current.metadata))
  f.revoke()
  await expect(historicalSourceIdentity(f.current.format, f.current.metadata)).rejects.toThrow('Released original')
})

it.each(['format', 'identity', 'digest', 'subset', 'role', 'duplicate', 'metadata-version'] as const)('refuses a changed compact comparison %s', async change => {
  const f = await fixture()
  let sources = f.sources, binding = f.binding
  if (change === 'format') binding = { ...binding, sourceFormat: 'legacy-v1' }
  if (change === 'identity') binding = { ...binding, sourceIdentity: '0'.repeat(64) }
  if (change === 'digest') binding = { ...binding, sourceDigest: '0'.repeat(64) }
  if (change === 'subset') sources = { ...sources, members: sources.members.map(member => ({ ...member, catalogSubset: [] })) }
  if (change === 'role') sources = { ...sources, bodies: [...sources.bodies, ...(sources.catalogBodies ?? [])], catalogBodies: [] }
  if (change === 'duplicate') sources = { ...sources, members: [...sources.members, ...sources.members] }
  if (change === 'metadata-version') {
    const raw = await readBackupMetadata(f.current.metadata) as Record<string, unknown>
    const metadata = metadataSource({ ...raw, version: 1 })
    const identity = await historicalSourceIdentity('compact-v2', metadata)
    sources = { ...sources, members: sources.members.map(member => ({ ...member, id: identity.id, metadata })) }
    binding = { ...binding, sourceIdentity: identity.id, sourceDigest: identity.metadataStreamDigest }
  }
  await expect(comparisonOriginal(sources, binding)).rejects.toThrow()
})
