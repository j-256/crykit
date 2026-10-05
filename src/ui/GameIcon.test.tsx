// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { catalogArtwork } from '../catalog/sprites'
import { createBlankLocalData } from '../domain/local-data'
import type { EntityId, EntityRef } from '../domain/types'
import { DefinitionArtwork } from './GameIcon'

describe('shared definition artwork', () => {
  it('renders an exact mod skill icon before its generic glyph and recovers after a failed image when the selection changes', async () => {
    const skill = Object.values(DEFAULT_CATALOG.entities).find(entity => entity.kind === 'ability' && entity.id.startsWith('mod:moonlight-project:') && catalogArtwork(DEFAULT_CATALOG.id, entity))!
    const ref = (entityId: EntityId): EntityRef => ({ kind: 'catalog', catalogId: DEFAULT_CATALOG.id, catalogRevisionId: DEFAULT_CATALOG.revisionId, entityId })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const render = (value: EntityRef) => root.render(<DefinitionArtwork catalogs={[DEFAULT_CATALOG]} localData={createBlankLocalData()} value={value}/>)
    try {
      await act(async () => render(ref(skill.id)))
      expect(container.querySelector('[data-artwork-source="mod"] img')).not.toBeNull()
      expect(container.querySelector('[data-game-icon]')).toBeNull()
      await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
      expect(container.querySelector('[data-artwork-placeholder="ability"]')).not.toBeNull()
      await act(async () => render(ref('mod:moonlight-project:class:26' as EntityId)))
      expect(container.querySelector('[data-artwork-source="mod"] img')).not.toBeNull()
      expect(container.querySelector('[data-artwork-placeholder]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
