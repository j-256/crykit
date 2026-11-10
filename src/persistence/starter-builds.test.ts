import { afterEach, expect, it, vi } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import { saveBuildRevision } from '../domain/builds'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { appendStarterBuilds } from './starter-builds'
import records from './starter-build-records.json' with { type: 'json' }

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
it('appends the native starter graph without changing the sample baseline or manufacturing history', () => {
  const sample = createSampleLocalData(CURRENT_CATALOG)
  const before = structuredClone(sample)
  const result = appendStarterBuilds(sample)
  expect(sample).toEqual(before)
  expect(result).toMatchObject({ id: sample.id, revision: sample.revision, createdAt: sample.createdAt, updatedAt: sample.updatedAt, changes: sample.changes, playthroughs: sample.playthroughs, personalDefinitions: sample.personalDefinitions })
  expect(Object.values(result.builds).filter(build => build.tags.includes('sample')).map(build => build.title)).toEqual(expect.arrayContaining(['Judite', 'Marco', 'Prudence', 'Marcy']))
  expect(Object.keys(result.gameSetups)).toHaveLength(Object.keys(sample.gameSetups).length + Object.keys(records.gameSetups).length)
  const builds = ['Judite', 'Prudence', 'Marcy'].map(title => Object.values(result.builds).find(build => build.title === title)!)
  expect(new Set(builds.map(build => build.gameSetupId)).size).toBe(1)
  expect(Object.values(result.builds).find(build => build.title === 'Marco')!.gameSetupId).not.toBe(builds[0]!.gameSetupId)
  expect(() => validateNativeLocalDataGraph(result, [CURRENT_CATALOG])).not.toThrow()
})
it('allocates fresh editable identities and detaches nested starter content on every initialization', () => {
  const sample = createSampleLocalData(CURRENT_CATALOG)
  const first = appendStarterBuilds(sample), second = appendStarterBuilds(sample)
  for (const field of ['gameSetups', 'builds', 'buildRevisions'] as const) {
    const added = Object.keys(first[field]).filter(id => !Object.hasOwn(sample[field], id))
    expect(added.every(id => !Object.hasOwn(second[field], id))).toBe(true)
  }
  const firstBuild = Object.values(first.builds).find(build => build.title === 'Judite')!
  const secondBuild = Object.values(second.builds).find(build => build.title === 'Judite')!
  expect(first.buildRevisions[firstBuild.latestRevisionId!]!.content).not.toBe(second.buildRevisions[secondBuild.latestRevisionId!]!.content)
  expect(Object.keys(records.builds)).not.toContain(firstBuild.id)
})

it('keeps supplied checkpoints editable without changing their saved source revision', () => {
  const localData = appendStarterBuilds(createSampleLocalData(CURRENT_CATALOG))
  const build = Object.values(localData.builds).find(build => build.title === 'Prudence')!
  const original = localData.buildRevisions[build.latestRevisionId!]!
  const changed = saveBuildRevision(localData, { buildId: build.id, gameSetupRevisionId: original.gameSetupRevisionId, content: { ...original.content, rotationNotes: 'Synthetic editable starter note' }, expectedRevision: localData.revision })
  const next = changed.buildRevisions[changed.builds[build.id]!.latestRevisionId!]!
  expect(next.id).not.toBe(original.id)
  expect(next.content.rotationNotes).toBe('Synthetic editable starter note')
  expect(changed.buildRevisions[original.id]).toEqual(original)
  expect(next.catalogLock).toEqual(original.catalogLock)
  expect(changed.gameSetups).toEqual(localData.gameSetups)
})
