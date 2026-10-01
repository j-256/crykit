import { childAt, childCount, objectProperty } from '../../mod-inspector/document'
import type { JsonNode, JsonPath } from '../../mod-inspector/types'

export interface ExpansionRule {
  readonly path: JsonPath
  readonly open: boolean
  readonly descendants?: boolean
}

export type VisibleTreeRow = { readonly kind: 'node'; readonly node: JsonNode; readonly open: boolean; readonly order: readonly number[] } | { readonly kind: 'more'; readonly node: JsonNode; readonly remaining: number; readonly order: readonly number[] }
const key = (path: JsonPath) => JSON.stringify(path)
const contains = (parent: JsonPath, child: JsonPath) => parent.length <= child.length && parent.every((part, index) => part === child[index])
const container = (node: JsonNode) => node.kind === 'object' || node.kind === 'array'

export function isExpanded(rules: readonly ExpansionRule[], path: JsonPath): boolean {
  let inherited = false
  let depth = -1
  for (const rule of rules) {
    if (!contains(rule.path, path)) continue
    if (rule.path.length === path.length) return rule.open
    if (rule.descendants !== undefined && rule.path.length > depth) { inherited = rule.descendants; depth = rule.path.length }
  }
  return inherited
}

export function setExpansion(rules: readonly ExpansionRule[], path: JsonPath, open: boolean, recursive: boolean): readonly ExpansionRule[] {
  const own = rules.find(rule => key(rule.path) === key(path))
  const retained = rules.filter(rule => recursive ? !contains(path, rule.path) : key(rule.path) !== key(path))
  return [...retained, recursive ? { path, open, descendants: open } : { ...own, path, open }]
}

export function revealPath(rules: readonly ExpansionRule[], path: JsonPath): readonly ExpansionRule[] {
  let result = rules
  for (let depth = 0; depth < path.length; depth++) result = setExpansion(result, path.slice(0, depth), true, false)
  return result
}

export function prepareVisibleTree(root: JsonNode, rules: readonly ExpansionRule[], pages: ReadonlyMap<string, number>, selected: JsonPath, budget: number, pageSize: number): { readonly rows: readonly VisibleTreeRow[]; readonly hasMore: boolean } {
  const targetRows: VisibleTreeRow[] = []
  let target = root
  let order: readonly number[] = [root.start]
  targetRows.push({ kind: 'node', node: target, open: isExpanded(rules, target.path), order })
  for (const part of selected) {
    if (!container(target) || !isExpanded(rules, target.path)) break
    const child = target.kind === 'array' && typeof part === 'number' ? childAt(target, part) : typeof part === 'string' ? objectProperty(target, part) : undefined
    if (!child) break
    order = [child.start]; target = child
    targetRows.push({ kind: 'node', node: target, open: isExpanded(rules, target.path), order })
  }
  const rows: VisibleTreeRow[] = []
  const included = new Set<string>()
  type ChildFrame = { readonly kind: 'children'; readonly node: JsonNode; readonly count: number; readonly index: number; readonly limit: number }
  const stack: (VisibleTreeRow | ChildFrame)[] = [{ kind: 'node', node: root, open: isExpanded(rules, root.path), order: [root.start] }]
  const focus = targetRows.findLast(row => row.kind === 'node' && container(row.node) && row.open)
  if (focus && focus.node !== root) stack.push(focus)
  const capacity = Math.max(1, budget - targetRows.length)
  while (stack.length && rows.length < capacity) {
    const row = stack.pop()!
    if (row.kind === 'children') {
      if (row.index < row.limit) {
        const child = childAt(row.node, row.index)!
        stack.push({ ...row, index: row.index + 1 })
        stack.push({ kind: 'node', node: child, open: isExpanded(rules, child.path), order: [child.start] })
      } else if (row.limit < row.count) stack.push({ kind: 'more', node: row.node, remaining: row.count - row.limit, order: [childAt(row.node, row.limit)?.start ?? row.node.end] })
      continue
    }
    if (row.kind === 'node' && included.has(key(row.node.path))) continue
    rows.push(row)
    if (row.kind !== 'node') continue
    included.add(key(row.node.path))
    if (!container(row.node) || !row.open) continue
    const count = childCount(row.node)
    const limit = Math.min(count, pages.get(key(row.node.path)) ?? pageSize)
    stack.push({ kind: 'children', node: row.node, count, index: 0, limit })
  }
  const hasMore = stack.some(row => row.kind !== 'children' || row.index < row.limit || row.limit < row.count)
  for (const row of targetRows) if (!included.has(key(row.node.path))) rows.push(row)
  rows.sort((a, b) => {
    for (let index = 0; index < Math.min(a.order.length, b.order.length); index++) if (a.order[index] !== b.order[index]) return a.order[index]! - b.order[index]!
    return a.order.length - b.order.length
  })
  return { rows, hasMore }
}
