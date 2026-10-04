import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { EntityId } from '../domain/types'
import { ClassWorldArtwork } from './WikiSprite'

describe('class standing artwork', () => {
  it('preserves the full-body display size while using local native frames', () => {
    const markup = renderToStaticMarkup(<ClassWorldArtwork catalogId="crystal-project-public-starter" detailed entity={{ id: 'base:job:0' as EntityId, kind: 'class', name: 'Warrior' }}/>)
    expect(markup).toContain('data-artwork-source="native"')
    expect(markup).toContain('alt="Warrior game artwork"')
    expect(markup).toContain('width="100"')
    expect(markup).toContain('height="72"')
    expect(markup).not.toContain('/wiki-sprites/')
  })

  it('keeps a placeholder for an unbound class instead of borrowing matching names', () => {
    const markup = renderToStaticMarkup(<ClassWorldArtwork catalogId="crystal-project-public-starter" detailed entity={{ id: 'synthetic:warrior' as EntityId, kind: 'class', name: 'Warrior' }}/>)
    expect(markup).toContain('Warrior artwork placeholder')
    expect(markup).not.toContain('<img')
  })
})
