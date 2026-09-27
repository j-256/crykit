import { describe, expect, it } from 'vitest'
import type { EntityId } from '../domain/types'
import { wikiSprite } from './sprites'

describe('bundled artwork identity', () => {
  const entity = { id: 'base:item:short-sword' as EntityId, kind: 'item' as const }
  const builtin = 'crystal-project-public-starter'

  it('resolves the exact built-in definition to a local asset and pinned attribution', () => {
    const sprite = wikiSprite(builtin, entity)
    expect(sprite?.url).toMatch(/wiki-sprites\/[^/]+\.gif/)
    expect(sprite?.url).not.toMatch(/^https?:/)
    expect(sprite?.asset.descriptionUrl).toMatch(/File%3AShort-sword-icon\.gif\?oldid=\d+$/)
    expect(sprite?.asset.license).toContain('Fairuse')
    expect(sprite?.binding.sources[0].url).toContain('?oldid=')
  })

  it('does not attach artwork to foreign catalogs, different kinds, or unknown identities', () => {
    expect(wikiSprite('synthetic-import', entity)).toBeUndefined()
    expect(wikiSprite(builtin, { ...entity, kind: 'ability' })).toBeUndefined()
    expect(wikiSprite(builtin, { ...entity, id: 'synthetic:item:short-sword' as EntityId })).toBeUndefined()
  })
})
