import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { defaultBattleCalculation } from '../domain/battle-plan'
import { createBuildPlan } from '../domain/build-planning'
import { defaultCalculation } from '../domain/calculation-plan'
import { compareBuildRevisions } from '../domain/comparison'
import { createId } from '../domain/core'
import { captureCharacter, requirePlaythrough, saveBuildRevision } from '../domain'
import type { BattleCalculationPlan, BuildId, BuildRevisionId, CatalogEntityKind, CatalogRef } from '../domain/types'
import { validateNativeLocalDataGraph } from '../interchange/native'
import { NativeLocalDataSchema } from '../interchange/native-schema'
import { createSharePayload, decodeSharePayload, encodeSharePayload, saveSharedCopy, validateSharePayload } from '../interchange/share'
import { CryKitDatabase, setDatabaseForTests } from './database'
import { commitImport, exportBackup, loadLocalData, previewImport, saveLocalData } from './local-data'

let database: CryKitDatabase
beforeEach(() => { database = new CryKitDatabase(`battle-calculations-${crypto.randomUUID()}`); setDatabaseForTests(database) })
afterEach(async () => { vi.restoreAllMocks(); setDatabaseForTests(undefined); await database.delete() })
const ref = (kind: CatalogEntityKind): CatalogRef => ({ kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: Object.values(CURRENT_CATALOG.entities).find(entity => entity.kind === kind && entity.id.startsWith('base:'))!.id })
const battle = (): BattleCalculationPlan => ({ ...defaultBattleCalculation(), targetTurnCount: 3, target: ref('monster'), statuses: [{ ref: ref('status'), count: null }], targetStatuses: [{ ref: ref('status'), count: 3 }], previouslyAppliedStatuses: [ref('status')], userPreviouslyAppliedStatuses: [ref('status')], user: { hp: 100, mp: null, ap: 0 } })

it('preserves battle assumptions, unknowns, and exact references through backup, share, and saved copies', async () => {
  const loaded = await loadLocalData()
  const revisionId = createId<BuildRevisionId>('buildRevision')
  const id = createId<BuildId>('build')
  const calculation = { ...defaultCalculation(ref('class')), ability: ref('ability'), battle: battle() }
  const content = { primaryClass: ref('class'), secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation }
  const planned = createBuildPlan(loaded.localData, { id, revisionId, title: 'Synthetic battle scenario', catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, content })
  await saveLocalData(planned, loaded.revision)
  const saved = await loadLocalData()
  expect(saved.localData.buildRevisions[revisionId]!.content.calculation).toEqual(calculation)
  const payload = decodeSharePayload(encodeSharePayload(createSharePayload(saved.localData, { kind: 'build', revisionId })))
  expect(payload.records.buildRevisions[revisionId]!.content.calculation).toEqual(calculation)
  const copied = saveSharedCopy(saved.localData, payload)
  expect(copied.localData.buildRevisions[copied.localData.builds[copied.buildId!]!.latestRevisionId!]!.content.calculation).toEqual(calculation)
  const restored = await commitImport(await previewImport(await exportBackup(), 'synthetic-battle.zip'))
  expect(restored.localData.buildRevisions[revisionId]!.content.calculation).toEqual(calculation)
  const changed = saveBuildRevision(saved.localData, { buildId: id, gameSetupRevisionId: saved.localData.buildRevisions[revisionId]!.gameSetupRevisionId, content: { ...content, calculation: { ...calculation, battle: { ...calculation.battle, targetTurnCount: 4 } } } })
  expect(compareBuildRevisions(saved.localData.buildRevisions[revisionId]!, changed.buildRevisions[changed.builds[id]!.latestRevisionId!]!).differences.some(difference => difference.path === 'content.calculation')).toBe(true)
  expect(saved.localData.buildRevisions[revisionId]!.content.calculation!.battle!.turnCount).toBe(0)
  expect(saved.localData.buildRevisions[revisionId]!.content.calculation!.battle!.targetTurnCount).toBe(3)
})

it('rejects unsupported scenarios and dangling battle references without changing saved records', async () => {
  const loaded = await loadLocalData()
  const revisionId = createId<BuildRevisionId>('buildRevision')
  const planned = createBuildPlan(loaded.localData, { revisionId, title: 'Synthetic validation', catalogLock: { [CURRENT_CATALOG.id]: CURRENT_CATALOG.revisionId }, content: { primaryClass: ref('class'), secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [], calculation: { ...defaultCalculation(ref('class')), battle: battle() } } })
  const payload = JSON.parse(JSON.stringify(createSharePayload(planned, { kind: 'build', revisionId })))
  payload.records.buildRevisions[revisionId].content.calculation.battle.version = 99
  expect(() => validateSharePayload(payload)).toThrow('malformed')
  const invalid = structuredClone(planned)
  const invalidBattle = invalid.buildRevisions[revisionId]!.content.calculation!.battle! as unknown as Record<string, unknown>
  invalidBattle.user = { hp: -1, mp: null, ap: null }
  expect(NativeLocalDataSchema.safeParse(invalid).success).toBe(false)
  for (const targetTurnCount of [undefined, -1, 0.5]) {
    const invalidTurns = structuredClone(planned)
    const invalidScenario = invalidTurns.buildRevisions[revisionId]!.content.calculation!.battle! as unknown as Record<string, unknown>
    invalidScenario.targetTurnCount = targetTurnCount
    expect(NativeLocalDataSchema.safeParse(invalidTurns).success).toBe(false)
  }
  for (const key of ['target', 'statuses', 'targetStatuses', 'previouslyAppliedStatuses', 'userPreviouslyAppliedStatuses']) {
    const dangling = structuredClone(planned)
    const scenario = dangling.buildRevisions[revisionId]!.content.calculation!.battle! as unknown as Record<string, unknown>
    const missing = { ...ref('status'), entityId: 'missing-synthetic-battle-reference' }
    scenario[key] = key === 'target' ? missing : key.endsWith('AppliedStatuses') ? [missing] : [{ ref: missing, count: 1 }]
    expect(() => validateNativeLocalDataGraph(dangling, loaded.catalogs)).toThrow()
  }
  expect((await loadLocalData()).localData).toEqual(loaded.localData)
})

it('preserves character observations and rolls back failed battle saves atomically', async () => {
  const loaded = await loadLocalData()
  const character = Object.values(requirePlaythrough(loaded.localData).characters)[0]!
  const original = character.snapshots[character.currentSnapshotId!]!
  const calculation = { ...defaultCalculation(ref('class')), battle: battle() }
  const candidate = captureCharacter(loaded.localData, { characterId: character.id, calculation })
  vi.spyOn(database.history, 'add').mockRejectedValueOnce(new DOMException('Synthetic quota failure', 'QuotaExceededError'))
  await expect(saveLocalData(candidate, loaded.revision)).rejects.toMatchObject({ code: 'storage-failure' })
  expect((await loadLocalData()).localData).toEqual(loaded.localData)
  await saveLocalData(candidate, loaded.revision)
  const saved = requirePlaythrough((await loadLocalData()).localData).characters[character.id]!
  expect(saved.snapshots[saved.currentSnapshotId!]!.calculation).toEqual(calculation)
  expect(saved.snapshots[original.id]).toEqual(original)
})
