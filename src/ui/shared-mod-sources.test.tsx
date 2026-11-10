import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { BUNDLED_CATALOGS, CURRENT_CATALOG } from '../catalog/bundled'
import { addGameSetupRevision, createBuild, saveBuildRevision } from '../domain'
import { buildContentForModSetup } from '../domain/build-mods'
import { modSourceReceipts } from '../domain/build-reference-names'
import { asId } from '../domain/core'
import { prepareModComposition } from '../domain/mod-layers'
import { createTestLocalData } from '../domain/test-helpers'
import type { BuildId } from '../domain/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { prepareLocalBuildModRecovery } from '../interchange/share-mod-recovery'
import { SharedModSources } from './SharedModSources'

it.each([false, true])('offers only exact selected local artwork after recovering a saved composed Build (historical=%s)', async historical => {
  const text = '{"ID":"artwork-recovery","Title":"Artwork source","Jobs":[{"ID":24,"Name":"Selected class"},{"ID":25,"Name":"Unselected class"}]}'
  const source = (await previewCrystalEdit(new TextEncoder().encode(text), 'source.json')).proposed.catalogs[0]!
  const catalogs = [...BUNDLED_CATALOGS, source]
  const modComposition = prepareModComposition({ version: 3, baseline: { catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId }, layers: [{ catalogId: source.id, catalogRevisionId: source.revisionId, enabled: true }], links: [] }, catalogs)
  let data = addGameSetupRevision(createTestLocalData(), { label: 'Artwork setup', modComposition, activate: true })
  const setup = data.gameSetups[data.planningGameSetupRevisionId!]!, buildId = asId<BuildId>('artwork-build')
  data = createBuild(data, { id: buildId, title: 'Artwork Build', gameSetupId: setup.gameSetupId })
  const entity = Object.values(source.entities).find(value => value.name === 'Selected class')!
  const content = buildContentForModSetup({ primaryClass: { kind: 'catalog', catalogId: source.id, catalogRevisionId: source.revisionId, entityId: entity.id }, secondaryClass: null, equipment: {}, passives: [], contextAssumptions: [] }, setup, catalogs)
  data = saveBuildRevision(data, { buildId, gameSetupRevisionId: setup.id, content })
  data = { ...data, gameSetups: { ...data.gameSetups, [setup.id]: { ...setup, modSourceReceipts: modSourceReceipts(setup, catalogs) } } }
  const saved = historical ? JSON.parse(JSON.stringify(data).replaceAll('library-v4', 'library-v2')) as typeof data : data
  const savedRevision = saved.buildRevisions[saved.builds[buildId]!.latestRevisionId!]!
  const original = JSON.stringify(saved)
  const recovered = prepareLocalBuildModRecovery(savedRevision.content, saved.gameSetups[savedRevision.gameSetupRevisionId]!, catalogs)
  expect(recovered.error).toBeUndefined()
  const draft = recovered.draft!
  const preview = { ...saved, gameSetups: { [draft.setup.id]: draft.setup }, buildRevisions: { [savedRevision.id]: { ...savedRevision, gameSetupRevisionId: draft.setup.id, catalogLock: draft.setup.catalogLock, content: draft.content } } }
  const revision = Object.values(preview.buildRevisions)[0]!, selected = revision.content.referenceNames![0]!
  expect(selected.ref.catalogRevisionId).not.toBe(source.revisionId)
  const render = (localData = preview, available = catalogs) => renderToStaticMarkup(<SharedModSources localData={localData} catalogs={available} onImport={async () => {}} onArtwork={() => {}}/>)
  expect(render()).toContain('Local artwork for Selected class')
  expect(render()).not.toContain('Local artwork for Unselected class')
  expect(render(preview, [...BUNDLED_CATALOGS])).not.toContain('Local artwork for')
  const replaceEntry = (entry: typeof selected) => ({ ...preview, buildRevisions: { ...preview.buildRevisions, [revision.id]: { ...revision, content: { ...revision.content, referenceNames: [entry] } } } })
  expect(render(replaceEntry({ ...selected, modelKey: 'crystal-edit:Jobs:99999' }))).not.toContain('Local artwork for')
  expect(render(replaceEntry({ ...selected, ref: { ...selected.ref, catalogRevisionId: source.revisionId } }))).not.toContain('Local artwork for')
  const selectedSetup = preview.gameSetups[revision.gameSetupRevisionId]!
  expect(render({ ...preview, gameSetups: { ...preview.gameSetups, [selectedSetup.id]: { ...selectedSetup, modComposition: { ...selectedSetup.modComposition!, layers: [] } } } })).not.toContain('Local artwork for')
  expect(JSON.stringify(saved)).toBe(original)
})
