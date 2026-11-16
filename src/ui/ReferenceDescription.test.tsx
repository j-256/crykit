import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { nativeDescription } from '../catalog/native-description'
import { nativeMechanic } from '../catalog/native-mechanics'
import type { CatalogEntity, EntityId } from '../domain/types'
import { ReferenceDescription } from './ReferenceDescription'

const entity = (id: string) => CURRENT_CATALOG.entities[id]!

describe('readable reference descriptions', () => {
  it('shows exact native equipment effects without mutating their source', () => {
    const dress = entity('base:equipment:134')
    const before = JSON.stringify(dress)
    expect(nativeDescription(dress)?.complete).toBe(true)
    const html = renderToStaticMarkup(<ReferenceDescription catalog={CURRENT_CATALOG} entity={dress}/>)
    expect(html).toMatch(/Resistance:\s*\+78/)
    expect(html).toMatch(/Max\. MP:\s*\+20/)
    expect(html).not.toContain('sources-trigger')
    expect(JSON.stringify(dress)).toBe(before)
  })

  it('displays exact native recovery and AP-cost mechanic facts', () => {
    const stew = entity('base:item:132')
    const html = renderToStaticMarkup(<ReferenceDescription entity={stew}/>)
    expect(html).toContain('100% Missing HP')
    expect(html).not.toContain('sources-trigger')
    const mechanic = entity('mechanic:stat:467')
    expect(nativeMechanic(mechanic)).toBeDefined()
    const mechanics = renderToStaticMarkup(<ReferenceDescription catalog={CURRENT_CATALOG} entity={mechanic}/>)
    expect(mechanics).toContain('Value1 (X) is the native ability ID.')
    expect(mechanics).toContain('Value2 (Y) is the flat AP-cost adjustment')
    expect(mechanics).not.toContain('sources-trigger')
  })

  it('fills a missing gameplay summary with attributed text while native descriptions keep precedence', () => {
    const shard = entity('base:item:22')
    expect(nativeDescription(shard)?.complete).toBe(false)
    const html = renderToStaticMarkup(<ReferenceDescription catalog={CURRENT_CATALOG} entity={shard} hideGeneratedSummary/>)
    expect(html).toContain('teleports the party to the roof of the Gaea Shrine')
    expect(html).toContain('Sources for Description')
    expect(html).not.toContain('No description supplied.')
    expect(html).not.toContain('base database')
    const dress = entity('base:equipment:134')
    expect(renderToStaticMarkup(<ReferenceDescription catalog={CURRENT_CATALOG} entity={dress}/>)).not.toContain('Sources for Description')
  })

  it('keeps class master directions separate from descriptions and acquisition notes', () => {
    const warrior = entity('base:job:0')
    const html = renderToStaticMarkup(<ReferenceDescription catalog={CURRENT_CATALOG} entity={warrior} hideGeneratedSummary/>)
    expect(html).toContain('Class master')
    expect(html).toContain('walk under the green roof')
    expect(html).not.toContain('Mastery reward')
    const sword = entity('base:equipment:0')
    expect(renderToStaticMarkup(<ReferenceDescription catalog={CURRENT_CATALOG} entity={sword}/>)).not.toContain('Nan&#x27;s Knick Knacks')
  })

  it('retains imported description evidence without promoting it to verified native prose', () => {
    const sources = [{ sourceId: 'https://example.test/synthetic-guide', locator: 'Synthetic custom description' }]
    const definition: CatalogEntity = { id: 'imported:synthetic' as EntityId, kind: 'item', name: 'Synthetic item', aliases: [], rawDescription: 'Synthetic imported effect', fields: { Description: { state: 'known', value: 'Synthetic imported effect', sources } }, sources }
    const before = JSON.stringify(definition)
    expect(nativeDescription(definition)).toBeUndefined()
    const html = renderToStaticMarkup(<ReferenceDescription entity={definition}/>)
    expect(html).toContain('Synthetic imported effect')
    expect(html).toContain('Sources for Description')
    expect(renderToStaticMarkup(<ReferenceDescription compact entity={definition}/>)).not.toContain('sources-trigger')
    expect(JSON.stringify(definition)).toBe(before)
    const original = entity('mechanic:stat:467')
    const changed = { ...original, rawDescription: 'Synthetic changed effect', fields: { ...original.fields, Description: { state: 'known' as const, value: 'Synthetic changed effect', sources } } }
    expect(nativeMechanic(changed)).toBeUndefined()
    expect(renderToStaticMarkup(<ReferenceDescription catalog={CURRENT_CATALOG} entity={changed}/>)).toContain('Sources for Description')
  })

  it('does not repeat authored native prose in full or compact descriptions', () => {
    const immortal = entity('base:passive:25')
    expect(nativeDescription(immortal)?.lines).toContain(immortal.rawDescription)
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(<ReferenceDescription compact={compact} entity={immortal}/>)
      expect(html.match(/Once per battle, automatically revive/g)).toHaveLength(1)
      expect(html).not.toContain('sources-trigger')
    }
  })
})
