import { describe, expect, it } from 'vitest'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { addGameSetupRevision, createBuild, saveBuildRevision } from '../domain'
import { asId, createId } from '../domain/core'
import { buildContentForModSetup } from '../domain/build-mods'
import { modCatalogRevision, prepareModComposition } from '../domain/mod-layers'
import { createTestLocalData } from '../domain/test-helpers'
import type { BuildId, CatalogRef, GameSetupRevisionId, SlotId } from '../domain/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { createSharePayload, sharePreviewData } from '../interchange/share'
import { prepareModCatalogs } from '../persistence/local-data'
import { prepareBuildModRecovery } from './build-mod-recovery'

async function fixture() {
  const source = (await previewCrystalEdit(new TextEncoder().encode('{"ID":"synthetic-draft-recovery","Title":"Synthetic Recovery Mod","Jobs":[{"ID":24,"Name":"Synthetic Recovery Class","EquipmentTypes":[2],"PassiveIDs":[]}]}'), 'mod.json')).proposed.catalogs[0]!
  const catalogs = [...BUNDLED_CATALOGS, source]
  const modComposition = prepareModComposition({ version: 3, baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] }, catalogs)
  let data = addGameSetupRevision(createTestLocalData(), { label: 'Synthetic recovery', modComposition, activate: true })
  const setup = data.gameSetups[data.planningGameSetupRevisionId!]!
  const buildId = asId<BuildId>('synthetic-recovery-build')
  data = createBuild(data, { id: buildId, title: 'Synthetic recovery', gameSetupId: setup.gameSetupId })
  const content = buildContentForModSetup({ primaryClass: { kind: 'catalog' as const, catalogId: source.id, catalogRevisionId: source.revisionId, entityId: Object.values(source.entities).find(entity => entity.kind === 'class')!.id }, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: ['Keep draft assumption'], rotationNotes: 'Keep draft rotation' }, setup, catalogs)
  data = saveBuildRevision(data, { buildId, gameSetupRevisionId: setup.id, content })
  const payload = createSharePayload(data, { kind: 'build', revisionId: data.builds[buildId]!.latestRevisionId! }, true, await prepareModCatalogs(data, catalogs))
  const original = sharePreviewData(JSON.parse(JSON.stringify(payload).replaceAll('library-v4', 'library-v2').replaceAll('catalog-v3', 'catalog-v1')))
  const revision = Object.values(original.buildRevisions)[0]!
  // An editor draft has a new setup identity while its references retain the saved origin pin
  const draftSetup = { ...original.gameSetups[revision.gameSetupRevisionId]!, id: createId<GameSetupRevisionId>('draftBehavior') }
  return { original, content: revision.content, draftSetup, catalogs, current: { data, setup, content } }
}

describe('draft mod definition recovery', () => {
  it.each([false, true])('rebinds an older interpretation without changing saved data or notes with an explicit empty retained selection field: %s', async explicitEmpty => {
    const { original, content, draftSetup, catalogs } = await fixture()
    const before = JSON.stringify(original)
    const recovery = prepareBuildModRecovery(explicitEmpty ? { ...content, retainedSelections: undefined } : content, draftSetup, original, catalogs)
    expect(recovery.error).toBeUndefined()
    expect(recovery.draft).toBeDefined()
    expect(recovery.draft!.content.rotationNotes).toBe(content.rotationNotes)
    expect(recovery.draft!.content.contextAssumptions).toEqual(content.contextAssumptions)
    expect(recovery.draft!.content.primaryClass).toMatchObject({ catalogRevisionId: modCatalogRevision(draftSetup.id) })
    expect(recovery.draft!.behavior.catalogLock[CURRENT_CATALOG.id]).toBe(modCatalogRevision(draftSetup.id))
    expect(recovery.draft!.behavior.modComposition!.baseline.catalogRevisionId).toBe(CURRENT_CATALOG.revisionId)
    expect(JSON.stringify(original)).toBe(before)
  })

  it('reopens exact matching sources without requiring a changed interpretation', async () => {
    const { current, catalogs } = await fixture()
    const recovery = prepareBuildModRecovery(current.content, current.setup, current.data, catalogs)
    expect(recovery.error).toBeUndefined()
    expect(recovery.draft).toBeDefined()
    expect(recovery.changedInterpretation).toBe(false)
    expect(recovery.draft!.content).toEqual(current.content)
  })

  it('preserves retained references, removed occupied slots and whole unsaved content while recovering active selections', async () => {
    const { original, content, draftSetup, catalogs } = await fixture()
    const retained: CatalogRef = { kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: asId('synthetic-retained-old-pin'), entityId: asId('base:equipment:300') }
    const removedSlot = asId<SlotId>('removed-slot')
    const draft = { ...content, secondaryClass: null, equipment: { ...content.equipment, [removedSlot]: { ref: retained } }, retainedSelections: { refs: [retained], slotIds: [removedSlot] }, rotationNotes: 'Whole unsaved rotation', contextAssumptions: ['Whole unsaved assumption'] }
    const before = structuredClone({ original, draft })
    const recovery = prepareBuildModRecovery(draft, draftSetup, original, catalogs)
    expect(recovery.error).toBeUndefined()
    expect(recovery.draft).toBeDefined()
    expect(recovery.draft!.content.retainedSelections).toEqual(draft.retainedSelections)
    expect(recovery.draft!.content.equipment).toEqual(draft.equipment)
    expect(recovery.draft!.content.rotationNotes).toBe(draft.rotationNotes)
    expect(recovery.draft!.content.contextAssumptions).toEqual(draft.contextAssumptions)
    expect(recovery.draft!.content.primaryClass).toMatchObject({ catalogRevisionId: modCatalogRevision(draftSetup.id) })
    expect({ original, draft }).toEqual(before)
  })

  it('waits for matching sources and reports incomplete identity recovery without touching the draft', async () => {
    const { original, content, draftSetup, catalogs } = await fixture()
    const before = JSON.stringify(content)
    const missing = prepareBuildModRecovery(content, draftSetup, original, BUNDLED_CATALOGS)
    expect(missing.draft).toBeUndefined()
    expect(missing.missingSources).toEqual(['Synthetic Recovery Mod'])
    const broken = { ...content, referenceNames: content.referenceNames!.map(entry => ({ ...entry, modelKey: 'crystal-edit:Jobs:65535' })) }
    const failed = prepareBuildModRecovery(broken, draftSetup, original, catalogs)
    expect(failed.draft).toBeUndefined()
    expect(failed.error).toContain('cannot resolve')
    expect(JSON.stringify(content)).toBe(before)
  })
})
