import { modModelEntity } from '../domain/mod-layers'
import { baseGameEntityId } from '../domain/entity-identities'
import { describe, expect, it } from 'vitest'
import { CRYSTAL_EDIT_FIELDS, exportedTree } from '../domain/crystal-edit'
import { learnTreeGraph } from '../domain/learn-tree'
import { asId } from '../domain/core'
import { NATIVE_RECORD_FIELD } from '../domain/native-game'
import { TEST_NOW } from '../domain/test-helpers'
import type { PersonalDefinition, PersonalDefinitionId } from '../domain/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { syntheticCrystalEdit } from '../interchange/crystal-edit.test-helpers'
import { DEFAULT_CATALOG } from './bundled'
import { addCrystalEditFacts } from './crystal-edit'
import { STARTER_CATALOG } from './starter'
import { bundledTreeIdentity, classTreeSkill } from './class-learn-tree'

describe('class-tree identity supplement', () => {
  it('resolves native tree skills within their database mode and preserves absent costs', () => {
    const monk = DEFAULT_CATALOG.entities[baseGameEntityId('job', 5, 'Vanilla')]!
    const node = exportedTree(monk).find(node => node.nodeType === 2 && node.dataId === 34)!
    const skill = classTreeSkill(monk, node, DEFAULT_CATALOG)
    expect(skill).toMatchObject({ name: 'Focus Energy', jp: 200, definition: { id: baseGameEntityId('ability', 34, 'Vanilla') } })
    const definition = skill.definition!
    const catalog = { ...DEFAULT_CATALOG, entities: { ...DEFAULT_CATALOG.entities, [definition.id]: { ...definition, fields: { ...definition.fields, [NATIVE_RECORD_FIELD]: { state: 'unknown' as const, reason: 'Synthetic missing source cost' } } } } }
    expect(classTreeSkill(monk, node, catalog).jp).toBeUndefined()
  })

  it('retains native identity for personal class versions without resolving changed numeric IDs', () => {
    const warrior = DEFAULT_CATALOG.entities['base:job:0']!
    const personal: PersonalDefinition = { id: asId<PersonalDefinitionId>('synthetic-native-warrior'), revision: 1, kind: 'class', name: 'Synthetic native Warrior', aliases: [], fields: warrior.fields, sources: warrior.sources, createdAt: TEST_NOW, updatedAt: TEST_NOW }
    const node = exportedTree(personal).find(node => node.nodeType === 2 && node.dataId === 28)!
    expect(classTreeSkill(personal, node, DEFAULT_CATALOG, warrior)).toMatchObject({ name: 'Taunt', jp: 0, definition: { id: 'base:ability:28' } })
    const unresolved = classTreeSkill(personal, { ...node, dataId: 999 }, DEFAULT_CATALOG, warrior)
    expect(unresolved.name).toBe('Ability #999')
    expect(unresolved.jp).toBeUndefined()
    expect(unresolved.definition).toBeUndefined()
  })

  it('resolves every skill in the exact bundled trees without mutating their content', () => {
    const catalog = DEFAULT_CATALOG
    const before = JSON.stringify(catalog)
    for (const entity of Object.values(catalog.entities).filter(entity => bundledTreeIdentity(entity))) {
      const graph = learnTreeGraph(exportedTree(entity))
      expect(graph.unresolved, entity.name).toEqual([])
      for (const node of graph.nodes) {
        const skill = classTreeSkill(entity, node, catalog)
        expect(skill.definition, `${entity.name}: ${skill.name}`).toBeDefined()
        expect(skill.jp, `${entity.name}: ${skill.name}`).toBeGreaterThanOrEqual(0)
        expect(skill.name).not.toMatch(/^(Ability|Passive) #/)
      }
    }
    expect(JSON.stringify(catalog)).toBe(before)
  })

  it('uses the numeric family and class-scoped identity for duplicate names', () => {
    const warrior = DEFAULT_CATALOG.entities['base:job:0']!
    const scholar = DEFAULT_CATALOG.entities['base:job:13']!
    const passive = classTreeSkill(warrior, exportedTree(warrior).find(node => node.nodeType === 3 && node.dataId === 4)!, DEFAULT_CATALOG)
    const magic = classTreeSkill(scholar, exportedTree(scholar).find(node => node.nodeType === 2 && node.dataId === 202)!, DEFAULT_CATALOG)
    expect(passive).toMatchObject({ name: 'Adrenaline', kind: 'passive', jp: 300, definition: { id: 'base:passive:4' } })
    expect(magic).toMatchObject({ name: 'Adrenaline', kind: 'monsterMagic', monsterLearned: true, definition: { id: 'base:ability:202' } })
  })

  it('leaves modified trees and unrelated imported trees with matching numeric IDs unresolved', () => {
    const original = addCrystalEditFacts(STARTER_CATALOG).entities['base:class:warrior']!
    const tree = exportedTree(original).map(node => ({ ...node, dataId: node.row === 0 && node.column === 1 ? 999 : node.dataId }))
    const changed = { ...original, fields: { ...original.fields, [CRYSTAL_EDIT_FIELDS.tree]: { state: 'known' as const, value: tree, sources: original.sources } } }
    expect(bundledTreeIdentity(changed)).toBeUndefined()
    const unknown = classTreeSkill(changed, tree.find(node => node.nodeType === 3 && node.dataId === 7)!, DEFAULT_CATALOG)
    expect(unknown.name).toBe('Passive #7')
    expect(unknown.jp).toBeUndefined()
    const unrelated = { ...original, fields: { ...original.fields, [CRYSTAL_EDIT_FIELDS.tree]: { state: 'known' as const, value: exportedTree(original).map(node => ({ ...node })), sources: [{ sourceId: 'synthetic-unrelated-mod' }] } } }
    expect(bundledTreeIdentity(unrelated)).toBeUndefined()
  })

  it('resolves imported definitions within their catalog and preserves missing costs and targets', async () => {
    const data = syntheticCrystalEdit()
    const preview = await previewCrystalEdit(new TextEncoder().encode(JSON.stringify(data)), 'synthetic.json')
    const catalog = preview.proposed.catalogs[0]!
    const job = modModelEntity(catalog, 'crystal-edit:Jobs:40')!
    const tree = exportedTree(job)
    expect(classTreeSkill(job, tree.find(node => node.nodeType === 2)!, catalog)).toMatchObject({ name: 'Synthetic Spark', jp: undefined, definition: { id: 'mod:synthetic-project:ability:8' } })
    const missing = classTreeSkill(job, tree.find(node => node.nodeType === 3)!, catalog)
    expect(missing.name).toBe('Passive #2')
    expect(missing.jp).toBeUndefined()
    const effective = { ...catalog, entities: { ...catalog.entities, 'synthetic:replacement': { ...modModelEntity(catalog, 'crystal-edit:Abilities:8')!, id: 'synthetic:replacement' as typeof job.id, name: 'Layer Spark', fields: { 'Crystal Edit source record': { state: 'known' as const, value: { JP: 125 } } } } }, legacy: { crystalEditIdentities: { 'crystal-edit:Abilities:8': 'synthetic:replacement' } } }
    expect(classTreeSkill(job, tree.find(node => node.nodeType === 2)!, effective)).toMatchObject({ name: 'Layer Spark', jp: 125, definition: { id: 'synthetic:replacement' } })
  })
})
