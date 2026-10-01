import { LEARN_NODE_TYPES, type ExportedTreeNode } from './crystal-edit'

export interface TreePosition { readonly row: number; readonly column: number }
export interface LearnTreeEdge {
  readonly from: TreePosition
  readonly to: TreePosition
}
export interface LearnTreeGraph {
  readonly nodes: readonly ExportedTreeNode[]
  readonly edges: readonly LearnTreeEdge[]
  readonly connectors: readonly { readonly from: ExportedTreeNode; readonly to: ExportedTreeNode }[]
  readonly unresolved: readonly TreePosition[]
}

export const treePositionKey = (position: TreePosition): string => `${position.row}:${position.column}`

export function learnTreeGraph(tree: readonly ExportedTreeNode[]): LearnTreeGraph {
  const cells = new Map(tree.map(node => [treePositionKey(node), node]))
  const nodes = [...cells.values()].filter(node => node.nodeType !== LEARN_NODE_TYPES.blank && node.nodeType !== LEARN_NODE_TYPES.gate).sort((a, b) => a.row - b.row || a.column - b.column)
  const edges: LearnTreeEdge[] = []
  const unresolved = new Map<string, TreePosition>()
  for (const target of nodes) {
    const visited = new Set<string>()
    const visit = (position: TreePosition, belowRow: number) => {
      if (position.row >= belowRow) { unresolved.set(treePositionKey(target), target); return }
      const key = treePositionKey(position)
      if (visited.has(key)) return
      visited.add(key)
      const cell = cells.get(treePositionKey(position))
      if (!cell || cell.nodeType === LEARN_NODE_TYPES.blank) { unresolved.set(treePositionKey(target), target); return }
      if (cell.nodeType === LEARN_NODE_TYPES.gate) {
        if (!cell.prerequisites.length) unresolved.set(treePositionKey(target), target)
        cell.prerequisites.forEach(prerequisite => visit(prerequisite, cell.row))
      } else if (cell.nodeType === LEARN_NODE_TYPES.ability || cell.nodeType === LEARN_NODE_TYPES.passive) edges.push({ from: cell, to: target })
      else unresolved.set(treePositionKey(target), target)
    }
    target.prerequisites.forEach(prerequisite => visit(prerequisite, target.row))
  }
  const connectors = [...cells.values()].flatMap(to => to.nodeType === LEARN_NODE_TYPES.blank ? [] : to.prerequisites.flatMap(position => {
    const from = cells.get(treePositionKey(position))
    return from && from.nodeType !== LEARN_NODE_TYPES.blank && from.row < to.row ? [{ from, to }] : []
  }))
  return { nodes, edges, connectors, unresolved: [...unresolved.values()] }
}
