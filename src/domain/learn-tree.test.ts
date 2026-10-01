import { describe, expect, it } from 'vitest'
import { LEARN_NODE_TYPES, type ExportedTreeNode } from './crystal-edit'
import { learnTreeGraph, treePositionKey } from './learn-tree'

function node(row: number, column: number, nodeType: number, prerequisites: ExportedTreeNode['prerequisites'] = []): ExportedTreeNode {
  return { row, column, nodeType, dataId: 0, prerequisites }
}

describe('learn-tree prerequisites', () => {
  it('traces long arrows through junctions without presenting empty cells or junctions as skills', () => {
    const graph = learnTreeGraph([
      node(0, 0, LEARN_NODE_TYPES.ability), node(0, 1, LEARN_NODE_TYPES.blank),
      node(1, 0, LEARN_NODE_TYPES.gate, [{ row: 0, column: 0 }]),
      node(2, 1, LEARN_NODE_TYPES.gate, [{ row: 1, column: 0 }]),
      node(3, 1, LEARN_NODE_TYPES.passive, [{ row: 2, column: 1 }]),
    ])
    expect(graph.nodes.map(treePositionKey)).toEqual(['0:0', '3:1'])
    expect(graph.edges.map(edge => [treePositionKey(edge.from), treePositionKey(edge.to)])).toEqual([['0:0', '3:1']])
    expect(graph.connectors.map(edge => [treePositionKey(edge.from), treePositionKey(edge.to)])).toEqual([['0:0', '1:0'], ['1:0', '2:1'], ['2:1', '3:1']])
    expect(graph.unresolved).toEqual([])
  })

  it('retains both branches of a reconverging arrow while naming each prerequisite once', () => {
    const graph = learnTreeGraph([
      node(0, 1, LEARN_NODE_TYPES.ability),
      node(1, 0, LEARN_NODE_TYPES.gate, [{ row: 0, column: 1 }]),
      node(1, 2, LEARN_NODE_TYPES.gate, [{ row: 0, column: 1 }]),
      node(2, 1, LEARN_NODE_TYPES.passive, [{ row: 1, column: 0 }, { row: 1, column: 2 }]),
    ])
    expect(graph.edges).toHaveLength(1)
    expect(graph.connectors).toHaveLength(4)
    expect(graph.unresolved).toEqual([])
  })

  it('preserves distinct prerequisites and separates dangling references, unknown node types, and cycles', () => {
    const graph = learnTreeGraph([
      node(0, 0, LEARN_NODE_TYPES.ability), node(0, 2, LEARN_NODE_TYPES.ability), node(0, 3, 8),
      node(1, 0, LEARN_NODE_TYPES.gate, [{ row: 1, column: 0 }]),
      node(2, 1, LEARN_NODE_TYPES.passive, [{ row: 0, column: 0 }, { row: 0, column: 2 }, { row: 0, column: 3 }, { row: 0, column: 5 }, { row: 1, column: 0 }]),
    ])
    expect(graph.edges.map(edge => treePositionKey(edge.from))).toEqual(['0:0', '0:2'])
    expect(graph.unresolved.map(treePositionKey)).toEqual(['2:1'])
  })

  it('bounds traversal through a densely branching imported tree', () => {
    const tree = [node(0, 0, LEARN_NODE_TYPES.ability), node(0, 1, LEARN_NODE_TYPES.ability)]
    for (let row = 1; row < 64; row++) for (let column = 0; column < 2; column++) tree.push(node(row, column, row === 63 ? LEARN_NODE_TYPES.passive : LEARN_NODE_TYPES.gate, [{ row: row - 1, column: 0 }, { row: row - 1, column: 1 }]))
    const graph = learnTreeGraph(tree)
    expect(graph.edges).toHaveLength(4)
    expect(graph.connectors).toHaveLength(252)
    expect(graph.unresolved).toEqual([])
  })

  it('reports a junction cycle without hanging or inventing a prerequisite', () => {
    const graph = learnTreeGraph([
      node(0, 0, LEARN_NODE_TYPES.gate, [{ row: 1, column: 0 }]),
      node(1, 0, LEARN_NODE_TYPES.gate, [{ row: 0, column: 0 }]),
      node(2, 0, LEARN_NODE_TYPES.ability, [{ row: 1, column: 0 }]),
    ])
    expect(graph.edges).toEqual([])
    expect(graph.unresolved.map(treePositionKey)).toEqual(['2:0'])
  })
})
