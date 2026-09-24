import type {
  QueryNode,
  QueryOperator,
  QueryRecord,
  QueryScalar,
  QueryValue,
  TruthValue,
} from './types'

export function notTruth(value: TruthValue): TruthValue {
  if (value === 'unknown') {
    return 'unknown'
  }
  return value === 'true' ? 'false' : 'true'
}

export function andTruth(values: readonly TruthValue[]): TruthValue {
  if (values.includes('false')) {
    return 'false'
  }
  return values.includes('unknown') ? 'unknown' : 'true'
}

export function orTruth(values: readonly TruthValue[]): TruthValue {
  if (values.includes('true')) {
    return 'true'
  }
  return values.includes('unknown') ? 'unknown' : 'false'
}

function scalarEquals(left: QueryScalar, right: QueryScalar): boolean {
  return Object.is(left, right)
}

function compareKnown(
  actual: QueryScalar | readonly QueryScalar[],
  operator: QueryOperator,
  expected?: QueryScalar | readonly QueryScalar[],
): boolean {
  if (operator === 'exists') {
    return true
  }
  if (operator === 'eq') {
    if (Array.isArray(actual)) {
      return Array.isArray(expected)
        ? actual.length === expected.length && actual.every((value, index) => scalarEquals(value, expected[index] ?? null))
        : actual.some((value) => scalarEquals(value, expected as QueryScalar))
    }
    return Array.isArray(expected)
      ? expected.some((value) => scalarEquals(actual as QueryScalar, value))
      : scalarEquals(actual as QueryScalar, expected as QueryScalar)
  }
  if (operator === 'contains') {
    if (typeof actual === 'string' && typeof expected === 'string') {
      return actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
    }
    if (Array.isArray(actual)) {
      return Array.isArray(expected)
        ? expected.every((candidate) => actual.some((value) => scalarEquals(value, candidate)))
        : actual.some((value) => scalarEquals(value, expected as QueryScalar))
    }
    return false
  }
  if (operator === 'in') {
    if (!Array.isArray(expected)) {
      return false
    }
    return Array.isArray(actual)
      ? actual.some((value) => expected.some((candidate) => scalarEquals(value, candidate)))
      : expected.some((candidate) => scalarEquals(actual as QueryScalar, candidate))
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return false
  }
  if (typeof actual === 'number' && typeof expected === 'number') {
    switch (operator) {
      case 'gt':
        return actual > expected
      case 'gte':
        return actual >= expected
      case 'lt':
        return actual < expected
      case 'lte':
        return actual <= expected
      default:
        return false
    }
  }
  if (typeof actual === 'string' && typeof expected === 'string') {
    switch (operator) {
      case 'gt':
        return actual > expected
      case 'gte':
        return actual >= expected
      case 'lt':
        return actual < expected
      case 'lte':
        return actual <= expected
      default:
        return false
    }
  }
  return false
}

export function evaluatePredicate(
  value: QueryValue | undefined,
  operator: QueryOperator,
  expected?: QueryScalar | readonly QueryScalar[],
): TruthValue {
  if (value === undefined || value.state === 'unknown' || value.state === 'conflicting') {
    return 'unknown'
  }
  if (value.state === 'notApplicable') {
    return 'false'
  }
  return compareKnown(value.value, operator, expected) ? 'true' : 'false'
}

export function evaluateQuery(node: QueryNode, record: QueryRecord): TruthValue {
  switch (node.kind) {
    case 'predicate':
      return evaluatePredicate(record[node.field], node.operator, node.value)
    case 'not':
      return notTruth(evaluateQuery(node.child, record))
    case 'and':
      return andTruth(node.children.map((child) => evaluateQuery(child, record)))
    case 'or':
      return orTruth(node.children.map((child) => evaluateQuery(child, record)))
  }
}

export interface QueryPartition<Item> {
  readonly confirmed: readonly Item[]
  readonly possible: readonly Item[]
  readonly excluded: readonly Item[]
}

export function partitionQuery<Item>(
  items: readonly Item[],
  query: QueryNode,
  project: (item: Item) => QueryRecord,
): QueryPartition<Item> {
  const confirmed: Item[] = []
  const possible: Item[] = []
  const excluded: Item[] = []
  for (const item of items) {
    const result = evaluateQuery(query, project(item))
    if (result === 'true') {
      confirmed.push(item)
    } else if (result === 'unknown') {
      possible.push(item)
    } else {
      excluded.push(item)
    }
  }
  return { confirmed, possible, excluded }
}
