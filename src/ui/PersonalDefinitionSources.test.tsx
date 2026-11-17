import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { catalogSource } from '../domain/catalog-source'
import { createBlankLocalData, createPersonalDefinition } from '../domain/local-data'
import type { PersonalDefinitionId } from '../domain/types'
import { DefinitionSourcesPanel } from './DefinitionDetailSections'
import { PersonalDefinitionSources } from './PersonalDefinitionSources'

const id = 'synthetic-personal-sources' as PersonalDefinitionId
const definition = createPersonalDefinition(createBlankLocalData(), { id, name: 'Synthetic personal sword', kind: 'item', fields: { Attack: { state: 'known', value: 10 } } }).personalDefinitions[id]!
const render = (props: Parameters<typeof PersonalDefinitionSources>[0]) => {
  const element = PersonalDefinitionSources(props)
  const panel = DefinitionSourcesPanel(element.props)
  return { html: renderToStaticMarkup(element), content: renderToStaticMarkup(panel.props.children) }
}
const onOpenDefinition = () => undefined

describe('personal definition source ownership', () => {
  it('does not invent a source control or original for a new unsourced definition', () => {
    expect(definition.sources).toEqual([])
    expect(definition.baseRef).toBeUndefined()
    const { html, content } = render({ definition, onOpenDefinition })
    expect(html).not.toContain('Sources for')
    expect(content).not.toContain('original definition')
  })

  it('retains original native provenance only for a resolved source ancestor', () => {
    const source = catalogSource([CURRENT_CATALOG], { kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: CURRENT_CATALOG.entities['base:equipment:160']!.id })!
    expect(source).toBeDefined()
    const saved = { ...definition, sources: source.entity.sources }
    const before = JSON.stringify(saved)
    const { html, content } = render({ definition: saved, source, onOpenDefinition })
    expect(html).toContain('Sources for Synthetic personal sword')
    expect(content).toContain('Sources refer to the original definition.')
    expect(content).toContain('Database/equipment.dat/160')
    expect(JSON.stringify(saved)).toBe(before)
    expect(render({ definition: saved, onOpenDefinition }).content).not.toContain('original definition')
  })

  it('retains imported source links and uncertainty without claiming a resolved original', () => {
    const sources = [{ sourceId: 'https://example.test/synthetic-original', locator: 'Synthetic imported row', snapshot: 'Synthetic revision 2' }]
    const imported = render({ definition: { ...definition, sources }, onOpenDefinition })
    expect(imported.html).toContain('Sources for Synthetic personal sword')
    expect(imported.content).toContain('href="https://example.test/synthetic-original"')
    expect(imported.content).toContain('Synthetic revision 2')
    expect(imported.content).not.toContain('original definition')
    const unknown = render({ definition: { ...definition, fields: { Attack: { state: 'unknown', reason: 'Synthetic observation needed' } } }, onOpenDefinition })
    expect(unknown.html).toContain('Sources for Synthetic personal sword')
    expect(unknown.content).toContain('No source recorded.')
    expect(unknown.content).not.toContain('original definition')
  })
})
