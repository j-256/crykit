import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { CLASS_FIELDS, CRYSTAL_EDIT_FIELDS, exportedTree } from '../domain/crystal-edit'
import { nativeRelationships } from '../domain/native-game'
import { ClassLearnTree } from './ClassLearnTree'

describe('learn-tree prerequisite text', () => {
  it('describes simultaneous requirements accessibly and retains missing nodes', () => {
    const container = document.createElement('div')
    const entity = { ...DEFAULT_CATALOG.entities['base:class:aegis']!, fields: { [CLASS_FIELDS.tree]: { state: 'known' as const, value: [
      { row: 0, column: 0, nodeType: 2, dataId: 7, prerequisites: [] },
      { row: 1, column: 1, nodeType: 2, dataId: 8, prerequisites: [{ row: 0, column: 0 }, { row: 0, column: 2 }] },
    ] } } }
    container.innerHTML = renderToStaticMarkup(<ClassLearnTree entity={entity}/>)
    const destination = container.querySelector('[data-position="1:1"]')!
    expect(destination.textContent).toContain('Ability #8')
    expect(destination.textContent).toContain('Requires all: Ability #7. Prerequisite unknown')
    expect(container.querySelector('ol')?.getAttribute('aria-label')).toBe('Learn tree skills')
    expect(container.textContent).toContain('All incoming prerequisites must be learned')
  })

  it('resolves native names in their own catalog and retains unresolved identities', () => {
    const entity = DEFAULT_CATALOG.entities['base:class:aegis']!
    const nodes = exportedTree(entity)
    const links = nativeRelationships(DEFAULT_CATALOG, entity)
    const destination = nodes.find(node => node.prerequisites.length > 1 && node.nodeType === 3)!
    const link = links.find(link => link.label === `/LearnTree/${destination.column}/${destination.row}/DataID`)!
    const catalog = { ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [`crystal-edit:Passives:${destination.dataId}`]: { ...entity, name: 'Unrelated editor passive' } } }
    const html = renderToStaticMarkup(<ClassLearnTree catalog={catalog} entity={entity}/>)
    expect(html).toContain(link.name!)
    expect(html).not.toContain('Unrelated editor passive')
    const entities = { ...catalog.entities }
    delete entities[link.targetId!]
    const unresolved = renderToStaticMarkup(<ClassLearnTree catalog={{ ...catalog, entities }} entity={{ ...entity, fields: { ...entity.fields, [CRYSTAL_EDIT_FIELDS.tree]: { state: 'unknown' } } }}/>)
    expect(unresolved).toContain(`Passive #${destination.dataId}`)
    expect(unresolved).not.toContain('Unrelated editor passive')
  })
})
