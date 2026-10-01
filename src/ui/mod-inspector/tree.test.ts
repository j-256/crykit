import { describe, expect, it, vi } from 'vitest'
import { parseDocument } from '../../mod-inspector/document'
import type { JsonNode, JsonPath } from '../../mod-inspector/types'
import { isExpanded, prepareVisibleTree, revealPath, setExpansion } from './tree'

const providers = vi.hoisted(() => new WeakMap<JsonNode, { readonly count: number; readonly at: (index: number) => JsonNode | undefined }>())
vi.mock('../../mod-inspector/document', async importOriginal => {
  const original = await importOriginal<typeof import('../../mod-inspector/document')>()
  return {
    ...original,
    childCount: (node: JsonNode) => providers.get(node)?.count ?? original.childCount(node),
    childAt: (node: JsonNode, index: number) => { const provider = providers.get(node); return provider ? provider.at(index) : original.childAt(node, index) },
  }
})

describe('recursive branch expansion rules', () => {
  it('expands all descendants without enumerating nodes and preserves sibling overrides', () => {
    let rules = setExpansion([], ['Left'], true, true)
    rules = setExpansion(rules, ['Right'], true, true)
    rules = setExpansion(rules, ['Left'], false, true)
    expect(isExpanded(rules, ['Left', 'Deep', 0])).toBe(false)
    expect(isExpanded(rules, ['Right', 'Deep', 0])).toBe(true)
    rules = setExpansion(rules, ['Left'], true, false)
    expect(isExpanded(rules, ['Left'])).toBe(true)
    expect(isExpanded(rules, ['Left', 'Deep'])).toBe(false)
  })
  it('clears old descendant expansion when collapsing a branch, including nested exceptions', () => {
    let rules = setExpansion([], [], true, true)
    rules = setExpansion(rules, ['Left', 'Deep'], true, false)
    rules = setExpansion(rules, ['Left'], false, true)
    expect(rules.some(rule => rule.path.length > 1 && rule.path[0] === 'Left')).toBe(false)
    rules = setExpansion(rules, ['Left'], true, false)
    expect(isExpanded(rules, ['Left', 'Deep'])).toBe(false)
    expect(isExpanded(rules, ['Right', 'Deep'])).toBe(true)
  })
  it('reveals selected ancestors without opening unrelated collapsed branches', () => {
    const rules = revealPath(setExpansion([], [], false, true), ['Left', 'Deep', 'Value'])
    expect(isExpanded(rules, [])).toBe(true)
    expect(isExpanded(rules, ['Left', 'Deep'])).toBe(true)
    expect(isExpanded(rules, ['Right'])).toBe(false)
  })
})

describe('bounded visible tree preparation', () => {
  it('never reads full children for a wide lazy branch and still reveals a distant selection', () => {
    const count = 1_000_000
    const created = new Map<number, JsonNode>()
    const root: JsonNode = { kind: 'array', path: [], start: 0, end: count + 1, raw: '[]', get children(): readonly JsonNode[] { throw new Error('Full child materialization is forbidden') } }
    providers.set(root, { count, at: index => {
      if (index < 0 || index >= count) return undefined
      let node = created.get(index)
      if (!node) { node = { kind: 'number', path: [index], start: index + 1, end: index + 2, raw: String(index), children: [] }; created.set(index, node) }
      return node
    } })
    const closed = prepareVisibleTree(root, [], new Map(), [], 40, 80)
    expect(closed.rows).toHaveLength(1)
    expect(created.size).toBe(0)
    const visible = prepareVisibleTree(root, setExpansion([], [], true, true), new Map(), [count - 1], 40, 80)
    expect(visible.rows.length).toBeLessThanOrEqual(40)
    expect(created.size).toBeLessThanOrEqual(40)
    expect(visible.rows.some(row => row.kind === 'node' && row.node.path[0] === count - 1)).toBe(true)
    expect(visible.hasMore).toBe(true)
  })
  it('bounds materialization of a recursively expanded branching tree', () => {
    let created = 0
    const node = (path: JsonPath): JsonNode => {
      created++
      let children: readonly JsonNode[] | undefined
      return { path, kind: 'object', start: 0, end: 2, raw: '{}', get children() { return children ??= Array.from({ length: 80 }, (_, index) => node([...path, `Child${index}`])) } }
    }
    const root = node([])
    const rules = setExpansion([], [], true, true)
    expect(created).toBe(1)
    const result = prepareVisibleTree(root, rules, new Map(), [], 100, 80)
    expect(result.rows.length).toBeLessThanOrEqual(100)
    expect(result.hasMore).toBe(true)
    expect(created).toBeLessThanOrEqual(100 * 80)
  })
  it('includes a distant selected row despite exhausted budget and child pagination', () => {
    const root = parseDocument(JSON.stringify({ Items: Array.from({ length: 100 }, (_, ID) => ({ ID, Nested: { Value: ID } })) })).root
    const selected = ['Items', 99, 'Nested', 'Value'] as const
    const rules = setExpansion([], [], true, true)
    const first = prepareVisibleTree(root, rules, new Map(), selected, 40, 10)
    expect(first.rows.length).toBeLessThanOrEqual(40)
    expect(first.rows.some(row => row.kind === 'node' && JSON.stringify(row.node.path) === JSON.stringify(selected))).toBe(true)
    expect(first.hasMore).toBe(true)
    const next = prepareVisibleTree(root, rules, new Map(), selected, 80, 10)
    expect(next.rows.length).toBeGreaterThan(first.rows.length)
    expect(next.rows.some(row => row.kind === 'more' && row.remaining === 90)).toBe(true)
  })
  it('gives a selected branch room even when earlier expanded siblings exhaust the row budget', () => {
    const root = parseDocument(JSON.stringify({ Earlier: Array.from({ length: 100 }, (_, Value) => ({ Value })), Later: { Nested: { Value: 42 } } })).root
    const rules = setExpansion([], [], true, true)
    for (const selected of [['Later'], ['Later', 'Nested', 'Value']]) {
      const visible = prepareVisibleTree(root, rules, new Map(), selected, 20, 10)
      expect(visible.rows.length).toBeLessThanOrEqual(20)
      expect(visible.rows.some(row => row.kind === 'node' && JSON.stringify(row.node.path) === '["Later","Nested","Value"]')).toBe(true)
      expect(visible.hasMore).toBe(true)
    }
  })
})
