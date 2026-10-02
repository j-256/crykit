import type { JsonNode, JsonNodeKind, JsonPath, ParsedDocument } from './types'
import { MAX_MOD_SOURCE_BYTES, MAX_MOD_SOURCE_NODES } from '../domain/mod-library'

export const DOCUMENT_LIMITS = Object.freeze({ textLength: MAX_MOD_SOURCE_BYTES, nodes: MAX_MOD_SOURCE_NODES, depth: 128 })
const MAX_CACHED_CHILD_NODES = 4096
const MAX_PINNED_CHILD_NODES = 32_768
const MAX_PINNED_COLLECTIONS = 128
const CHILD_SEEK_STRIDE = 1024
const INITIAL_CHILD_SPANS = 128
interface ChildSpan { kind: JsonNodeKind; start: number; end: number; key?: string }
interface ChildAccess {
  count(): number
  at(index: number): JsonNode | undefined
  property(key: string): JsonNode | undefined
}
const childAccess = new WeakMap<JsonNode, ChildAccess>()
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/
const JSON_SPACE = /[\x20\t\r\n]/

class DocumentParser {
  private offset = 0
  private count = 0
  private cachedChildCount = 0
  private pinnedChildCount = 0
  private readonly childCache = new Map<number, readonly JsonNode[]>()
  private readonly pinnedChildCache = new Map<number, readonly JsonNode[]>()
  private readonly spanCache = new Map<string, ChildSpan>()
  private readonly pinnedSpans = new Map<string, ChildSpan>()
  private readonly rootChildren = new Map<number, JsonNode>()
  private readonly requestedNodes = new Map<number, JsonNode>()

  constructor(private readonly text: string, private readonly allowBom: boolean) {}

  private fail(message: string): never {
    const prefix = this.text.slice(0, this.offset)
    const line = prefix.split('\n').length
    const column = this.offset - prefix.lastIndexOf('\n')
    throw new Error(`${message} at line ${line}, column ${column} (offset ${this.offset})`)
  }

  private whitespace(): void {
    while (this.offset < this.text.length && JSON_SPACE.test(this.text[this.offset])) this.offset++
  }

  private string(decode = true): string {
    const start = this.offset++
    while (this.offset < this.text.length) {
      const character = this.text[this.offset++]
      if (character === '"') {
        if (!decode) return ''
        try {
          return JSON.parse(this.text.slice(start, this.offset)) as string
        } catch {
          this.fail('Invalid JSON string or escape')
        }
      }
      if (character.charCodeAt(0) < 0x20) this.fail('Unescaped control character in JSON string')
      if (character === '\\') {
        const escape = this.text[this.offset++]
        if (escape === 'u') {
          if (!/^[\da-fA-F]{4}$/.test(this.text.slice(this.offset, this.offset + 4))) this.fail('Invalid Unicode escape')
          this.offset += 4
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) {
          this.fail('Invalid JSON escape')
        }
      }
    }
    this.fail('Unterminated JSON string')
  }

  private scanValue(depth: number, checkLimits = true): JsonNodeKind {
    if (checkLimits && depth > DOCUMENT_LIMITS.depth) this.fail(`Document nesting exceeds ${DOCUMENT_LIMITS.depth}; flatten deeply nested data before importing`)
    if (checkLimits && ++this.count > DOCUMENT_LIMITS.nodes) this.fail(`Document exceeds ${DOCUMENT_LIMITS.nodes} values; split the mod into smaller documents`)
    this.whitespace()
    const token = this.text[this.offset]
    if (token === '{' || token === '[') {
      const kind = token === '{' ? 'object' : 'array'
      const endToken = kind === 'object' ? '}' : ']'
      const keys = checkLimits ? new Set<string>() : undefined
      this.offset++
      this.whitespace()
      if (this.text[this.offset] !== endToken) {
        for (;;) {
          this.whitespace()
          if (kind === 'object') {
            if (this.text[this.offset] !== '"') this.fail('Expected a quoted object property name')
            const childKey = this.string(checkLimits)
            if (keys?.has(childKey)) this.fail(`Duplicate object property ${JSON.stringify(childKey)}; keep one definition before importing`)
            keys?.add(childKey)
            this.whitespace()
            if (this.text[this.offset++] !== ':') this.fail('Expected a colon after the object property name')
          }
          this.scanValue(depth + 1, checkLimits)
          this.whitespace()
          if (this.text[this.offset] === endToken) break
          if (this.text[this.offset++] !== ',') this.fail(`Expected a comma or ${endToken}`)
        }
      }
      this.offset++
      return kind
    }
    if (token === '"') {
      this.string(false)
      return 'string'
    }
    if (token === '-' || (token !== undefined && /\d/.test(token))) {
      const match = JSON_NUMBER.exec(this.text.slice(this.offset))
      if (!match) this.fail('Invalid JSON number')
      this.offset += match[0].length
      return 'number'
    }
    for (const literal of ['true', 'false', 'null']) {
      if (this.text.startsWith(literal, this.offset)) {
        this.offset += literal.length
        return literal === 'null' ? 'null' : 'boolean'
      }
    }
    this.fail('Expected a JSON value')
  }

  private lazyNode(kind: JsonNodeKind, start: number, end: number, getPath: () => JsonPath, key?: string): JsonNode {
    const parser = this
    let path: JsonPath | undefined
    const node: JsonNode = {
      kind, start, end,
      ...(key !== undefined ? { key } : {}),
      get raw() { return parser.text.slice(start, end) },
      get path() { return path ??= getPath() },
      get value() {
        return kind === 'string' || kind === 'boolean' || kind === 'null'
          ? JSON.parse(parser.text.slice(start, end)) as string | boolean | null
          : undefined
      },
      get children() {
        if (kind !== 'object' && kind !== 'array') return []
        const pinned = parser.pinnedChildCache.get(start)
        if (pinned) return pinned
        const cached = parser.childCache.get(start)
        if (cached) {
          parser.childCache.delete(start)
          parser.childCache.set(start, cached)
          return cached
        }
        const scanner = new DocumentParser(parser.text, false)
        scanner.offset = start + 1
        scanner.whitespace()
        const result: JsonNode[] = []
        while (scanner.offset < end - 1) {
          let childKey: string | undefined
          if (kind === 'object') {
            childKey = scanner.string()
            scanner.whitespace()
            scanner.offset++
          }
          scanner.whitespace()
          const childStart = scanner.offset
          const childKind = scanner.scanValue(0, false)
          const component = childKey ?? result.length
          result.push(parser.lazyNode(childKind, childStart, scanner.offset, () => [...(path ??= getPath()), component], childKey))
          scanner.whitespace()
          if (parser.text[scanner.offset] === ',') scanner.offset++
          scanner.whitespace()
        }
        parser.cacheChildren(start, result, (path ??= getPath()).length <= 1)
        return result
      },
    }
    if (kind === 'object' || kind === 'array') childAccess.set(node, this.boundedChildren(node))
    return node
  }

  private readChild(scanner: DocumentParser, kind: JsonNodeKind, capture: boolean): ChildSpan | undefined {
    let key: string | undefined
    if (kind === 'object') {
      const decoded = scanner.string(capture)
      if (capture) key = decoded
      scanner.whitespace()
      scanner.offset++
    }
    scanner.whitespace()
    const start = scanner.offset
    const childKind = scanner.scanValue(0, false)
    const end = scanner.offset
    scanner.whitespace()
    if (this.text[scanner.offset] === ',') scanner.offset++
    scanner.whitespace()
    return capture ? { kind: childKind, start, end, ...(key !== undefined ? { key } : {}) } : undefined
  }

  private cacheSpan(key: string, span: ChildSpan): void {
    this.spanCache.delete(key)
    this.spanCache.set(key, span)
    if (this.spanCache.size > MAX_CACHED_CHILD_NODES) this.spanCache.delete(this.spanCache.keys().next().value!)
  }

  private boundedChildren(node: JsonNode): ChildAccess {
    const parser = this
    let count: number | undefined
    const checkpoints: number[] = []
    let nextIndex = 0
    let nextOffset = node.start + 1
    const scannerAt = (offset: number): DocumentParser => {
      const scanner = new DocumentParser(parser.text, false)
      scanner.offset = offset
      scanner.whitespace()
      return scanner
    }
    const childCount = (): number => {
      if (count !== undefined) return count
      const scanner = scannerAt(node.start + 1)
      let index = 0
      while (scanner.offset < node.end - 1) {
        if (index % CHILD_SEEK_STRIDE === 0) checkpoints.push(scanner.offset)
        const span = parser.readChild(scanner, node.kind, index < INITIAL_CHILD_SPANS)
        if (span) {
          const key = `${node.start}:${index}`
          parser.cacheSpan(key, span)
          if (node.path.length <= 1 && parser.pinnedSpans.size < MAX_PINNED_CHILD_NODES) parser.pinnedSpans.set(key, span)
        }
        index++
      }
      count = index
      return count
    }
    const spanAt = (index: number): ChildSpan | undefined => {
      if (index >= childCount()) return undefined
      const cacheKey = `${node.start}:${index}`
      const cached = parser.pinnedSpans.get(cacheKey) ?? parser.spanCache.get(cacheKey)
      if (cached) {
        parser.cacheSpan(cacheKey, cached)
        return cached
      }
      const checkpoint = Math.floor(index / CHILD_SEEK_STRIDE)
      let current = checkpoint * CHILD_SEEK_STRIDE
      let offset = checkpoints[checkpoint]
      if (nextIndex <= index && nextIndex >= current) {
        current = nextIndex
        offset = nextOffset
      }
      const scanner = scannerAt(offset)
      let span: ChildSpan | undefined
      while (current <= index) span = parser.readChild(scanner, node.kind, current++ === index)
      nextIndex = index + 1
      nextOffset = scanner.offset
      parser.cacheSpan(cacheKey, span!)
      return span
    }
    const materialize = (span: ChildSpan, index: number): JsonNode => {
      let child = parser.rootChildren.get(span.start) ?? parser.requestedNodes.get(span.start)
      if (!child) child = parser.lazyNode(span.kind, span.start, span.end, () => [...node.path, span.key ?? index], span.key)
      if (node.path.length === 0 && parser.rootChildren.size < MAX_PINNED_COLLECTIONS) parser.rootChildren.set(span.start, child)
      parser.requestedNodes.delete(span.start)
      parser.requestedNodes.set(span.start, child)
      if (parser.requestedNodes.size > MAX_CACHED_CHILD_NODES) parser.requestedNodes.delete(parser.requestedNodes.keys().next().value!)
      return child
    }
    return {
      count: childCount,
      at(index) {
        const span = spanAt(index)
        return span ? materialize(span, index) : undefined
      },
      property(key) {
        const length = childCount()
        for (let index = 0; index < length; index++) {
          const span = spanAt(index)!
          if (span.key === key) return materialize(span, index)
        }
        return undefined
      },
    }
  }

  private cacheChildren(start: number, children: readonly JsonNode[], pin: boolean): void {
    if (pin && this.pinnedChildCount + children.length <= MAX_PINNED_CHILD_NODES && this.pinnedChildCache.size < MAX_PINNED_COLLECTIONS) {
      this.pinnedChildCache.set(start, children)
      this.pinnedChildCount += children.length
      return
    }
    if (children.length > MAX_CACHED_CHILD_NODES) return
    while (this.cachedChildCount + children.length > MAX_CACHED_CHILD_NODES || this.childCache.size >= MAX_CACHED_CHILD_NODES) {
      const oldest = this.childCache.keys().next().value
      if (oldest === undefined) break
      this.cachedChildCount -= this.childCache.get(oldest)!.length
      this.childCache.delete(oldest)
    }
    this.childCache.set(start, children)
    this.cachedChildCount += children.length
  }

  parse(requireObject: boolean): ParsedDocument {
    if (this.text.length > DOCUMENT_LIMITS.textLength) this.fail(`Document exceeds ${DOCUMENT_LIMITS.textLength} characters; split the mod into smaller documents`)
    if (this.allowBom && this.text.charCodeAt(0) === 0xfeff) this.offset++
    this.whitespace()
    const start = this.offset
    const kind = this.scanValue(0)
    const root = this.lazyNode(kind, start, this.offset, () => [])
    this.whitespace()
    if (this.offset !== this.text.length) this.fail('Unexpected content after the JSON value')
    if (requireObject && root.kind !== 'object') this.fail('A mod document must have a JSON object at its root')
    return { text: this.text, root, nodeCount: this.count }
  }
}

export function parseDocument(text: string): ParsedDocument {
  return new DocumentParser(text, true).parse(true)
}

/** Counts source-backed children without creating their nodes */
export function childCount(node: JsonNode): number {
  if (node.kind !== 'object' && node.kind !== 'array') return 0
  return childAccess.get(node)?.count() ?? node.children.length
}

/** Creates only the requested child; sibling offsets use sparse source checkpoints */
export function childAt(node: JsonNode, index: number): JsonNode | undefined {
  if (!Number.isInteger(index) || index < 0 || (node.kind !== 'object' && node.kind !== 'array')) return undefined
  const access = childAccess.get(node)
  return access ? access.at(index) : node.children[index]
}

/** The third argument is a requested length, rather than an end index */
export function childSlice(node: JsonNode, start: number, count: number): readonly JsonNode[] {
  if (!Number.isInteger(start) || start < 0 || !Number.isInteger(count) || count <= 0) return []
  const end = Math.min(childCount(node), start + count)
  const result: JsonNode[] = []
  for (let index = start; index < end; index++) result.push(childAt(node, index)!)
  return result
}

export function objectProperty(node: JsonNode, key: string): JsonNode | undefined {
  if (node.kind !== 'object') return undefined
  const access = childAccess.get(node)
  return access ? access.property(key) : node.children.find(child => child.key === key)
}

export function nodeAtPath(root: JsonNode, path: JsonPath): JsonNode | undefined {
  let node: JsonNode | undefined = root
  for (const component of path) {
    if (node?.kind === 'object' && typeof component === 'string') node = objectProperty(node, component)
    else if (node?.kind === 'array' && typeof component === 'number' && Number.isInteger(component) && component >= 0) node = childAt(node, component)
    else return undefined
  }
  return node
}

export function formatJsonPath(path: JsonPath): string {
  return '$' + path.map(component => typeof component === 'number' ? `[${component}]` : /^[A-Za-z_$][\w$]*$/.test(component) ? `.${component}` : `[${JSON.stringify(component)}]`).join('')
}

export function replaceJsonValue(text: string, path: JsonPath, replacementJson: string): string {
  const parsed = parseDocument(text)
  const target = nodeAtPath(parsed.root, path)
  if (!target) throw new Error(`Cannot edit missing value at ${formatJsonPath(path)}`)
  new DocumentParser(replacementJson, false).parse(false)
  const result = text.slice(0, target.start) + replacementJson + text.slice(target.end)
  parseDocument(result)
  return result
}
