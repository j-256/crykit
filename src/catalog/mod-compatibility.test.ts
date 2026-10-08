import { expect, it } from 'vitest'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { modRevision } from '../domain/mod-library'
import { sha256 } from '../interchange/util'
import { crystalEditPlanningRecord, CRYSTAL_EDIT_VERSION_FIELD } from '../domain/crystal-edit-compatibility'

it.each([4, 34])('archives the original synthetic format %i', async editorVersion => {
  const bytes = new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-version', Title: 'Synthetic Version', EditorVersion: editorVersion, Passives: [{ ID: 9000, Name: 'Synthetic passive', PP: 1 }] }))
  const preview = await previewCrystalEdit(bytes, 'synthetic.json')
  const catalog = preview.proposed.catalogs[0]!
  expect(catalog.id).toBe('crystal-edit:synthetic-version')
  expect(modRevision(catalog)?.editorVersion).toBe(editorVersion)
  expect(catalog.checksum).toBe(`sha256:${await sha256(bytes)}`)
  expect(preview.proposed.sources[0]!.bytes).toEqual(bytes)
})

it('interprets an omitted version as format 0 while retaining the original bytes and project identity', async () => {
  const bytes = new TextEncoder().encode('{"ID":"synthetic project / 0","Passives":[{"ID":9000,"Name":"Synthetic legacy","StatMods":[{"Tag":482,"Value1":12,"Value2":0}]}]}')
  const preview = await previewCrystalEdit(bytes, 'synthetic.json')
  const catalog = preview.proposed.catalogs[0]!
  const definition = Object.values(catalog.entities)[0]!
  expect(definition.fields[CRYSTAL_EDIT_VERSION_FIELD]).toMatchObject({ state: 'known', value: 0 })
  expect(definition.fields['Source mod project ID']).toMatchObject({ state: 'known', value: catalog.id })
  expect(crystalEditPlanningRecord(definition)?.StatMods).toEqual([{ Tag: 482, Value1: -1, Value2: 0 }])
  expect(preview.proposed.sources[0]!.bytes).toEqual(bytes)
})

it('keeps localization records outside legacy mechanical conversions', async () => {
  const preview = await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-localization', EditorVersion: 4, IsLocalization: true, Abilities: [{ ID: 9000, Name: 'Synthetic label', HideIfUnusable: true, AbilityMods: [{ Tag: 29, Value1: 90, Value2: 0 }] }] })), 'synthetic.json')
  const definition = Object.values(preview.proposed.catalogs[0]!.entities)[0]!
  expect(crystalEditPlanningRecord(definition)).toMatchObject({ HideIfUnusable: true, AbilityMods: [{ Tag: 29, Value1: 90, Value2: 0 }] })
})
