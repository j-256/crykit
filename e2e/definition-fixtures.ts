import { zipSync } from 'fflate'
import { replacePlannerData } from './local-data-helpers'
import { expect, type Page } from '@playwright/test'
import { BUNDLED_CATALOGS } from '../src/catalog/bundled'
import { savedCatalogVersion } from '../src/domain/legacy-definition.test-helpers'
import { createPersonalDefinition } from '../src/domain/local-data'
import { personalDefinitionRef } from '../src/domain/definitions'
import { formatEntityRefPath } from '../src/ui/navigation'
import type { EntityId, LocalData, PersonalDefinition, PersonalDefinitionId } from '../src/domain/types'

export async function readPlannerData(page: Page): Promise<LocalData> {
  await expect(page.getByText('Saved locally', { exact: true })).toBeAttached()
  return page.evaluate(() => new Promise<LocalData>((resolve, reject) => {
    const request = indexedDB.open('crykit')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const get = database.transaction('localDatas').objectStore('localDatas').get('local-data-record')
      get.onsuccess = () => { database.close(); resolve(get.result.localData) }
      get.onerror = () => { database.close(); reject(get.error) }
    }
  }))
}

async function storeFixture(page: Page, localData: LocalData, definition: PersonalDefinition) {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
  const archive = zipSync({
    'manifest.json': encode({ format: 'crykit-backup', formatVersion: '2.1.0', exportedAt: localData.updatedAt, payload: 'bundle.json', sources: [] }),
    'bundle.json': encode({ localData: { ...localData, changes: [] }, lineage: { rootLocalDataId: localData.id }, catalogs: [], bundledCatalogs: BUNDLED_CATALOGS.map(({ id, revisionId, checksum }) => ({ id, revisionId, checksum })), evidence: [], history: [] }),
  })
  await page.goto('/#/settings/data')
  const panel = page.getByRole('dialog', { name: 'Data & settings', exact: true })
  await panel.getByLabel('Choose import file', { exact: true }).setInputFiles({ name: 'synthetic-saved-definition.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) })
  await replacePlannerData(panel)
  await expect(panel).not.toBeVisible()
  await page.goto(`/#/reference/${formatEntityRefPath(personalDefinitionRef(definition))}`)
  await expect(page.getByRole('heading', { name: definition.name, exact: true })).toBeVisible()
  return definition
}

export async function openSavedCatalogVersion(page: Page, entityId: string, name: string, values: Pick<Parameters<typeof savedCatalogVersion>[2], 'fields' | 'aliases'> = {}) {
  const source = await readPlannerData(page)
  const setup = source.planningGameSetupRevisionId ? source.gameSetups[source.planningGameSetupRevisionId] : undefined
  const baseline = setup?.modComposition?.baseline
  const catalog = BUNDLED_CATALOGS.find(candidate => baseline ? candidate.id === baseline.catalogId && candidate.revisionId === baseline.catalogRevisionId : setup?.catalogLock[candidate.id] === candidate.revisionId)
  if (!catalog) throw new Error('The fixture has no pinned bundled base catalog')
  const saved = savedCatalogVersion(source, [catalog], { sourceRef: { kind: 'catalog', catalogId: catalog.id, catalogRevisionId: catalog.revisionId, entityId: entityId as EntityId }, name, ...values })
  return storeFixture(page, saved.localData, saved.definition)
}

export async function openCustomDefinition(page: Page, name = 'Synthetic custom sword') {
  const source = await readPlannerData(page)
  const id = 'synthetic-custom-sword' as PersonalDefinitionId
  const data = createPersonalDefinition(source, { id, name, kind: 'item', fields: { Attack: { state: 'known', value: 10 }, 'Cost (copper)': { state: 'known', value: 1000 } } })
  return storeFixture(page, data, data.personalDefinitions[id]!)
}
