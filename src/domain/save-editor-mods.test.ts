import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { SAVE_EDITOR_CATALOG } from '../catalog/save-editor'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { entityDefinitionKey } from './core'
import { createModdedSaveEditorFixture, createSaveEditorFixture, createSaveEditorModProjectFixture, setSaveEditorFixtureMode } from './save-editor.fixture'
import { createSaveEditorModSource, saveEditorDefinitionId, saveEditorDefinitionScope } from './save-editor-mods'
import { nativeIdentity } from './native-game'

const text = new TextEncoder()

describe('save editor Crystal Edit sources', () => {
  it('projects exact project identity, version, and supported records', async () => {
    const project = createSaveEditorModProjectFixture()
    const preview = await previewCrystalEdit(text.encode(JSON.stringify(project)), 'synthetic.json')
    const source = createSaveEditorModSource(preview.proposed.catalogs[0]!, preview.warnings)
    expect(source).toMatchObject({ id: project.ID, title: project.Title, version: project.Version, editorVersion: 34, origin: 'file', issues: [] })
    expect(source.records.job.get(24)).toMatchObject({ ID: 24, Name: 'Synthetic mod class', PassiveIDs: [88, 111] })
    expect(source.records.passive.get(88)).toMatchObject({ ID: 88, Name: 'Synthetic passive 88', PP: 0 })
  })

  it('marks archived model families as unsupported for save editing', async () => {
    const project = { ID: 'synthetic-entity-mod', Title: 'Entity mod', Version: '1', EditorVersion: 34, Entities: [{ ID: 4000 }] }
    const preview = await previewCrystalEdit(text.encode(JSON.stringify(project)), 'entity.json')
    const source = createSaveEditorModSource(preview.proposed.catalogs[0]!, preview.warnings)
    expect(source.issues).toContain('Unsupported model families are present: archived models')
  })

  it('scopes picker definitions to native data and exact active mod redirects', async () => {
    const preview = await previewCrystalEdit(text.encode(JSON.stringify(createSaveEditorModProjectFixture())), 'synthetic.json')
    const source = createSaveEditorModSource(preview.proposed.catalogs[0]!, preview.warnings)
    const scope = saveEditorDefinitionScope(createModdedSaveEditorFixture({ relocated: true }), DEFAULT_CATALOG, [source])
    const classRef = scope.refs.job.get(27)!
    const passiveRef = scope.refs.passive.get(188)!
    expect(classRef.catalogId).toBe(source.catalog!.id)
    expect(saveEditorDefinitionId(scope, classRef, 'job')).toBe(27)
    expect(saveEditorDefinitionId(scope, passiveRef, 'passive')).toBe(188)
    expect(scope.bindings.get(entityDefinitionKey(classRef))).toEqual({ family: 'job', id: 27 })
    expect(scope.catalogs[0]!.entities).not.toHaveProperty('mod:equipment-expansion:equipment:592')
  })

  it('selects mode-specific native picker definitions while retaining base Build bindings', () => {
    const mode = SAVE_EDITOR_CATALOG.modePatches.get(1)!.mode
    const scope = saveEditorDefinitionScope(setSaveEditorFixtureMode(createSaveEditorFixture(), 1), DEFAULT_CATALOG, [], mode)
    const modeRef = scope.refs.passive.get(74)!
    expect(nativeIdentity(scope.catalogs[0]!.entities[modeRef.entityId]!)).toMatchObject({ database: 'passive', databaseId: 74, mode: 'Vanilla' })
    const baseEntry = Object.entries(DEFAULT_CATALOG.entities).find(([, entity]) => {
      const identity = nativeIdentity(entity)
      return identity?.database === 'passive' && identity.databaseId === 74 && identity.mode === 'base'
    })!
    const baseRef = { kind: 'catalog' as const, catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId: baseEntry[0] as typeof modeRef.entityId }
    expect(saveEditorDefinitionId(scope, baseRef, 'passive')).toBe(74)
    expect(scope.catalogs[0]!.entities).not.toHaveProperty(baseEntry[0])
  })
})
