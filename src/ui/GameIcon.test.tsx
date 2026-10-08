// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { buildBundledModEntities } from '../domain/bundled-mods'
import { NATIVE_GAME_DATA } from '../catalog/native-game'
import { SYNTHETIC_MOD_SNAPSHOT } from '../catalog/mod.test-helpers'
import { createBlankLocalData } from '../domain/local-data'
import type { EntityId, EntityRef } from '../domain/types'
import { DefinitionArtwork } from './GameIcon'

vi.mock('../catalog/sprites', async importOriginal => {
  const original = await importOriginal<typeof import('../catalog/sprites')>()
  return { ...original, catalogArtwork: (catalogId: string, entity: { id: string; kind: string; name?: string }) => entity.id.startsWith('mod:synthetic-library:') ? { source: 'mod', url: `/synthetic/${entity.kind}.png`, asset: { file: `synthetic-${entity.kind}.png`, width: 32, height: 32, license: 'Synthetic fixture' }, binding: { kind: entity.kind, name: entity.name ?? '', asset: `synthetic-${entity.kind}`, sources: [] } } : original.catalogArtwork(catalogId, entity as Parameters<typeof original.catalogArtwork>[1]) }
})

describe('shared definition artwork', () => {
  it('renders an exact mod skill icon before its generic glyph and recovers after a failed image when the selection changes', async () => {
    const entities = buildBundledModEntities(SYNTHETIC_MOD_SNAPSHOT, NATIVE_GAME_DATA.enums)
    const catalog = { ...DEFAULT_CATALOG, entities }
    const skill = Object.values(entities).find(entity => entity.kind === 'ability')!
    const ref = (entityId: EntityId): EntityRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const render = (value: EntityRef) => root.render(<DefinitionArtwork catalogs={[catalog]} localData={createBlankLocalData()} value={value}/>)
    try {
      await act(async () => render(ref(skill.id)))
      expect(container.querySelector('[data-artwork-source="mod"] img')).not.toBeNull()
      expect(container.querySelector('[data-game-icon]')).toBeNull()
      await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
      expect(container.querySelector('[data-artwork-placeholder="ability"]')).not.toBeNull()
      await act(async () => render(ref('mod:synthetic-library:class:26' as EntityId)))
      expect(container.querySelector('[data-artwork-source="mod"] img')).not.toBeNull()
      expect(container.querySelector('[data-artwork-placeholder]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
