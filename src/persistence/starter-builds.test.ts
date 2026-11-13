import { expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { createSampleLocalData } from '../domain/sample-data'
import { createStarterLocalData } from './local-data'

it('starts with labeled synthetic samples and launch source pins only', () => {
  const local = createStarterLocalData()
  const sample = createSampleLocalData(CURRENT_CATALOG)
  expect(Object.values(local.builds).map(value => value.title)).toEqual(Object.values(sample.builds).map(value => value.title))
  expect(Object.values(local.playthroughs).map(value => value.label)).toEqual(Object.values(sample.playthroughs).map(value => value.label))
  expect(Object.values(local.gameSetups).every(value => Object.values(value.catalogLock).every(revision => revision === CURRENT_CATALOG.revisionId))).toBe(true)
  expect(local.referenceLibrary?.excludedMods).toEqual([])
  expect(local.revision).toBe(0)
  expect(local.changes).toEqual([])
})
