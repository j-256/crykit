import { objectProperty } from './document'
import type { DocumentChange, JsonNode, ParsedDocument } from './types'

const MAX_EXACT_EXPONENT_DIGITS = 128

function jsonWhitespace(character: string): boolean {
  return character === ' ' || character === '\n' || character === '\r' || character === '\t'
}

function equalIgnoringWhitespace(before: string, after: string): boolean {
  let beforeOffset = 0
  let afterOffset = 0
  let inString = false
  let escaped = false
  for (;;) {
    if (!inString) {
      while (jsonWhitespace(before[beforeOffset])) beforeOffset++
      while (jsonWhitespace(after[afterOffset])) afterOffset++
    }
    if (beforeOffset === before.length || afterOffset === after.length) return beforeOffset === before.length && afterOffset === after.length
    const character = before[beforeOffset++]
    if (character !== after[afterOffset++]) return false
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
    } else if (character === '"') {
      inString = true
    }
  }
}

function exactNumber(raw: string): string {
  const [mantissa, exponent = '0'] = raw.toLowerCase().split('e')
  const negative = mantissa.startsWith('-')
  const unsigned = negative ? mantissa.slice(1) : mantissa
  const fractionLength = unsigned.includes('.') ? unsigned.length - unsigned.indexOf('.') - 1 : 0
  const digits = unsigned.replace('.', '').replace(/^0+/, '')
  if (!digits) return '0'
  const significant = digits.replace(/0+$/, '')
  const exponentDigits = exponent.replace(/^[+-]/, '').replace(/^0+/, '')
  if (exponentDigits.length > MAX_EXACT_EXPONENT_DIGITS) return `literal:${raw}`
  const normalizedExponent = `${exponent.startsWith('-') ? '-' : ''}${exponentDigits || '0'}`
  const power = BigInt(normalizedExponent) - BigInt(fractionLength) + BigInt(digits.length - significant.length)
  return `${negative ? '-' : ''}${significant}e${power}`
}

function identity(node: JsonNode): string | undefined {
  const id = objectProperty(node, 'ID')
  if (id?.kind === 'string') return `string:${id.value}`
  if (id?.kind === 'number') return `number:${exactNumber(id.raw)}`
  return undefined
}

function recordMap(nodes: readonly JsonNode[]): Map<string, JsonNode> | undefined {
  const result = new Map<string, JsonNode>()
  for (const node of nodes) {
    const id = identity(node)
    if (id === undefined || result.has(id)) return undefined
    result.set(id, node)
  }
  return result
}

function stableRecordIds(before: ReadonlyMap<string, JsonNode>, after: ReadonlyMap<string, JsonNode>): ReadonlySet<string> {
  const positions = new Map<string, number>()
  let position = 0
  for (const id of before.keys()) positions.set(id, position++)
  const sequence: { id: string; position: number; previous: number }[] = []
  for (const id of after.keys()) {
    const originalPosition = positions.get(id)
    if (originalPosition !== undefined) sequence.push({ id, position: originalPosition, previous: -1 })
  }
  const tails: number[] = []
  // Preserve a longest surviving subsequence so index shifts from insertions or deletions are not moves
  for (let index = 0; index < sequence.length; index++) {
    let lower = 0
    let upper = tails.length
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2)
      if (sequence[tails[middle]].position < sequence[index].position) lower = middle + 1
      else upper = middle
    }
    sequence[index].previous = lower > 0 ? tails[lower - 1] : -1
    tails[lower] = index
  }
  const stable = new Set<string>()
  for (let index = tails.at(-1) ?? -1; index >= 0; index = sequence[index].previous) stable.add(sequence[index].id)
  return stable
}

function family(node: JsonNode): string {
  return node.path.filter((component): component is string => typeof component === 'string').join(' / ') || 'Document'
}

function recordGroup(node: JsonNode, parent: string): string {
  const id = objectProperty(node, 'ID')
  const name = objectProperty(node, 'Name') ?? objectProperty(node, 'name')
  const label = name?.kind === 'string' ? String(name.value) : ''
  const idLabel = id?.kind === 'string' ? JSON.stringify(id.value) : id?.raw
  return `${parent}${label ? `: ${label}` : ''}${idLabel !== undefined ? ` (ID ${idLabel})` : ''}`
}

export function diffDocuments(original: ParsedDocument, draft: ParsedDocument): readonly DocumentChange[] {
  const changes: DocumentChange[] = []
  function compare(before: JsonNode | undefined, after: JsonNode | undefined, group: string): void {
    if (!before && after) {
      changes.push({ kind: 'added', path: after.path, group, after })
      return
    }
    if (before && !after) {
      changes.push({ kind: 'removed', path: before.path, group, before })
      return
    }
    if (!before || !after) return
    if (before.kind === after.kind && (before.raw === after.raw || ((before.kind === 'object' || before.kind === 'array') && equalIgnoringWhitespace(before.raw, after.raw)))) return
    const changed = () => changes.push({ kind: 'changed', path: after.path, beforePath: before.path, group, before, after })
    if (before.kind !== after.kind) {
      changed()
    } else if (before.kind === 'object') {
      const oldProperties = new Map(before.children.map(child => [child.key, child]))
      const newProperties = new Map(after.children.map(child => [child.key, child]))
      for (const key of new Set([...oldProperties.keys(), ...newProperties.keys()])) {
        const oldChild = oldProperties.get(key)
        const newChild = newProperties.get(key)
        compare(oldChild, newChild, before.path.length === 0 ? String(key) : group)
      }
    } else if (before.kind === 'array') {
      const oldChildren = before.children
      const newChildren = after.children
      const oldRecords = recordMap(oldChildren)
      const newRecords = recordMap(newChildren)
      if (oldRecords && newRecords) {
        const parent = family(after)
        const stable = stableRecordIds(oldRecords, newRecords)
        for (const id of new Set([...oldRecords.keys(), ...newRecords.keys()])) {
          const oldRecord = oldRecords.get(id)
          const newRecord = newRecords.get(id)
          const moved = oldRecord && newRecord && !stable.has(id)
          if (oldRecord && newRecord && !moved && oldRecord.raw === newRecord.raw) continue
          const record = newRecord ?? oldRecord!
          const recordLabel = recordGroup(record, parent)
          if (oldRecord && newRecord && moved) {
            changes.push({ kind: 'moved', path: newRecord.path, beforePath: oldRecord.path, group: recordLabel, before: oldRecord, after: newRecord })
          }
          compare(oldRecord, newRecord, recordLabel)
        }
      } else {
        for (let index = 0; index < Math.max(oldChildren.length, newChildren.length); index++) {
          const record = newChildren[index] ?? oldChildren[index]
          const label = record && objectProperty(record, 'ID') ? recordGroup(record, family(after)) : group
          compare(oldChildren[index], newChildren[index], label)
        }
      }
    } else if (before.kind === 'number') {
      if (before.raw !== after.raw && exactNumber(before.raw) !== exactNumber(after.raw)) changed()
    } else if (before.value !== after.value) {
      changed()
    }
  }
  compare(original.root, draft.root, 'Document')
  return changes
}
