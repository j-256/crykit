import { expect, it } from 'vitest'
import { createTestLocalData } from './test-helpers'
import { setModInReference } from './reference-library'
import { NativeLocalDataSchema, StoredNativeLocalDataSchema } from '../interchange/native-schema'

it('changes Reference membership without changing game configuration or saved selections', () => {
  const data = createTestLocalData()
  const excluded = setModInReference(data, 'name:synthetic mod', false, data.revision)
  expect(excluded.referenceLibrary).toEqual({ version: 1, excludedMods: ['name:synthetic mod'] })
  expect(excluded.gameSetups).toBe(data.gameSetups)
  expect(excluded.buildRevisions).toBe(data.buildRevisions)
  expect(excluded.playthroughs).toBe(data.playthroughs)
  expect(setModInReference(excluded, 'name:synthetic mod', false)).toBe(excluded)
  const restored = setModInReference(excluded, 'name:synthetic mod', true)
  expect(restored.referenceLibrary?.excludedMods).toEqual([])
  expect(() => setModInReference(excluded, 'name:synthetic mod', true, data.revision)).toThrow('expected revision')
})

it('keeps older data readable and retains unavailable mod identities without accepting unknown setting versions', () => {
  const data = createTestLocalData()
  expect(StoredNativeLocalDataSchema.parse(data).referenceLibrary).toBeUndefined()
  const excluded = setModInReference(data, 'crystal-edit:unavailable-source', false)
  expect(NativeLocalDataSchema.parse(excluded).referenceLibrary).toEqual(excluded.referenceLibrary)
  expect(() => NativeLocalDataSchema.parse({ ...excluded, referenceLibrary: { version: 2, excludedMods: [] } })).toThrow()
  expect(() => NativeLocalDataSchema.parse({ ...excluded, referenceLibrary: { version: 1, excludedMods: ['name:duplicate', 'name:duplicate'] } })).toThrow()
})
