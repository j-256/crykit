import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { addTestBuild, addTestDefinition, createTestLocalData, personalRef } from '../domain/test-helpers'
import { createPublicSnapshot, encodePublicSnapshot } from '../interchange/public-share'
import { PublicSharedView } from './PublicSharedView'
import type { PublicSnapshot } from '../interchange/public-share-schema'

it('renders a selected name when its kind and source origin are unavailable', () => {
  const ref = { kind: 'catalog' as const, catalogId: 'crystal-project/guide/synthetic-history', catalogRevisionId: 'v1', entityId: 'selected-shield' }
  const snapshot: PublicSnapshot = { version: 6, dataGeneration: 'catalog-sources-1', kind: 'build', title: 'Unresolved Build', setup: { baseline: null, layers: [], catalogLock: { [ref.catalogId]: ref.catalogRevisionId }, mode: { state: 'unknown' }, ppCostsNonNegative: { state: 'unknown' }, slots: [{ id: 'hand', label: 'Hand' }] }, slots: [{ primaryClass: null, secondaryClass: null, equipment: [{ slotId: 'hand', ref }], equipmentGroups: [], passives: [] }], receipts: [{ ref, name: 'Saved shield', kind: null, origin: null }] }
  const markup = renderToStaticMarkup(<PublicSharedView encoded={encodePublicSnapshot(snapshot)}/>)
  expect(markup).toContain('Saved shield')
  expect(markup).toContain('Source identity unavailable')
  expect(markup).not.toContain('Shared snapshot unavailable')
})

it('renders selected names and requirements as inert text without private source mechanics', () => {
  let localData = addTestDefinition(createTestLocalData(), 'secret-id')
  localData = addTestBuild(localData, 'public-title', '', { hand: { ref: personalRef('secret-id'), allocationId: 'SECRET_GROUP' } })
  const definition = localData.personalDefinitions['secret-id']!, revision = localData.buildRevisions['public-title-revision']!
  localData = { ...localData, personalDefinitions: { ...localData.personalDefinitions, [definition.id]: { ...definition, name: '<script>Selected sword</script>', rawDescription: 'SECRET_MECHANICS', fields: { art: { state: 'known', value: 'SECRET_ART' } } } }, buildRevisions: { ...localData.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, rotationNotes: '<img src=x onerror=alert(1)>', contextAssumptions: ['Visible user assumption'] } } } }
  const snapshot = createPublicSnapshot({ planner: { localData, catalogs: [] } } as Parameters<typeof createPublicSnapshot>[0], { kind: 'build', revisionId: revision.id }, { includeNotes: true })
  const markup = renderToStaticMarkup(<PublicSharedView encoded={encodePublicSnapshot(snapshot)}/> )
  expect(markup).toContain('&lt;script&gt;Selected sword&lt;/script&gt;')
  expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(markup).toContain('Visible user assumption')
  expect(markup).toContain('Selected entry requirements')
  for (const prohibited of ['SECRET_', 'secret-id', '<script>', '<img ', 'Save a copy', 'Calculated stats']) expect(markup).not.toContain(prohibited)
})

it('renders an actionable invalid-link error without a legacy interpretation fallback', () => {
  expect(renderToStaticMarkup(<PublicSharedView encoded="invalid"/>)).toContain('Shared snapshot unavailable')
})
