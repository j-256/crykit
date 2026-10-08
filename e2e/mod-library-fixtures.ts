import { IMPORTED_RULES_REVISION } from '../src/domain/game-rules'
import { MOD_LIBRARY_IMPORT_REVISION } from '../src/interchange/crystal-edit'
import { referencePath } from './reference-helpers'
import { bundledModEntityId } from '../src/domain/bundled-mods'
import { createHash } from 'node:crypto'
import { expect, type Page } from '@playwright/test'

const job = { ID: 0, Name: 'Warrior', HPRating: 80, MPRating: 30, StrRating: 80, VitRating: 80, DexRating: 80, AgiRating: 80, MndRating: 80, SpiRating: 80, SpdRating: 80, LckRating: 80, EquipmentTypes: [0], AbilityIDs: [], PassiveIDs: [], LearnTree: [], IsUnselectableJob: false, IsUnselectableSubJob: false }
export const SYNTHETIC_LIBRARY_ROOTS = [
  { ID: 'synthetic-equipment', Title: 'Synthetic Equipment', Version: '1', EditorVersion: 34, SteamWorkshopFileID: 123456, Equipment: [{ ID: 0, Name: 'Synthetic Blade', EquipmentType: 0, IsTwoHanded: false, StatMods: [] }, { ID: 9002, Name: 'Synthetic Axe', EquipmentType: 1, StatMods: [] }, { ID: 9000, Name: 'Synthetic Charm', EquipmentType: 18, StatMods: [] }] },
  { ID: 'synthetic-moonlight', Title: 'Synthetic Moonlight', Version: '1', EditorVersion: 34, Jobs: [{ ...job, ID: 26, Name: 'Synthetic Class', AbilitiesName: 'Synthetic Arts', AbilityIDs: [9002], LearnTree: [[{ NodeType: 2, DataID: 9002, LP: 4, PrereqLeft: false, PrereqMiddle: false, PrereqRight: false }]] }, { ...job, ID: 27, Name: 'Synthetic Second Class', AbilitiesName: 'Synthetic Combo' }], Abilities: [{ ID: 9002, Name: 'Synthetic Technique', Description: 'Synthetic action', JP: 400, IsMAbil: true, IsPAbil: false, HPCost: 0, MPCost: 0, APCost: 0, CTCost: 0, CDCost: 0, AbilityMods: [] }] },
  { ID: 'synthetic-rules', Title: 'Synthetic Rules', Version: '1', EditorVersion: 34, Jobs: [job], Abilities: [{ ID: 9000, Name: 'Raging Crash', Description: 'Synthetic action' }], Passives: [{ ID: 9000, Name: 'Counter', PP: 1, StatMods: [] }], Statuses: [{ ID: 9000, Name: 'Focus Chakra', StatMods: [] }] },
  { ID: 'synthetic-shield', Title: 'Synthetic Shield', Version: '1', EditorVersion: 34, Equipment: [{ ID: 9001, Name: 'Synthetic Shield', EquipmentType: 11, IsTwoHanded: false, StatMods: [] }] },
]
export const SYNTHETIC_INNATE_ROOT = { ID: 'synthetic-innates', Title: 'Synthetic Innates', Version: '1', EditorVersion: 34, Passives: [{ ID: 9000, Name: 'Synthetic Learnable Innate', PP: 6, JP: 200, IsInnate: true, IsLearnable: true, IsDefaultLocked: false, StatMods: [] }, { ID: 9001, Name: 'Synthetic Regular Passive', PP: 1, JP: 200, IsInnate: false, IsLearnable: true, StatMods: [] }] }
export const SYNTHETIC_LIBRARY_SOURCES = SYNTHETIC_LIBRARY_ROOTS.map(root => ({ projectId: root.ID, title: root.Title, version: root.Version, editorVersion: root.EditorVersion, sha256: createHash('sha256').update(JSON.stringify(root)).digest('hex'), models: Object.fromEntries(Object.entries(root).filter((entry): entry is [string, { ID: number }[]] => Array.isArray(entry[1])).map(([key, models]) => [key, models.map(model => model.ID)])) }))

export async function importSyntheticLibrary(page: Page, exclude = true, roots: readonly { ID: string; Title: string }[] = SYNTHETIC_LIBRARY_ROOTS) {
  await page.goto('/#/mods')
  for (const root of roots) {
    await page.getByLabel('Import mod JSON', { exact: true }).setInputFiles({ name: `${root.ID}.json`, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(root)) })
    const card = page.getByRole('region', { name: root.Title, exact: true })
    await expect(card.getByText('Imported JSON', { exact: true })).toBeVisible()
    if (exclude) {
      await card.getByRole('button', { name: 'Remove from Reference', exact: true }).click()
      await expect(card.getByRole('button', { name: 'Add to Reference', exact: true })).toBeVisible()
    }
  }
}

export function syntheticReferencePath(projectIndex: number, family: string, id: number, name: string) {
  const source = SYNTHETIC_LIBRARY_SOURCES[projectIndex]!
  return referencePath(bundledModEntityId(source.projectId, family, id), `crystal-edit:${source.projectId}`, `sha256:${source.sha256}:${IMPORTED_RULES_REVISION}:${MOD_LIBRARY_IMPORT_REVISION}`, name)
}
