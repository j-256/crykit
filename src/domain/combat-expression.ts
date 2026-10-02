export type CombatValue =
  | number
  | boolean
  | null
  | readonly CombatValue[]
  | { readonly [key: string]: CombatValue }
export type CombatExpression = number | boolean | null | string | readonly CombatExpression[]
export interface CombatFormula {
  readonly title: string
  readonly inputs: readonly string[]
  readonly steps: readonly { readonly name: string; readonly value: CombatExpression }[]
  readonly result: CombatExpression
  readonly evidence: readonly string[]
  readonly notes: readonly string[]
  readonly requirements?: readonly {
    readonly condition: CombatExpression
    readonly message: string
  }[]
}
export interface CombatRules {
  readonly limits: { readonly depth: number; readonly nodes: number; readonly collection: number }
  readonly formulas: Readonly<Record<string, CombatFormula>>
}
export interface CombatTraceEntry {
  readonly formula: string
  readonly step: string
  readonly value: CombatValue
}

export function traceCombatFormula(
  rules: CombatRules,
  name: string,
  inputs: readonly CombatValue[],
): { result: CombatValue; trace: readonly CombatTraceEntry[] } {
  const trace: CombatTraceEntry[] = []
  const result = evaluateCombatFormula(rules, name, inputs, (entry) => trace.push(entry))
  return { result, trace }
}

// Only bundled rules call this interpreter; imported packages are never evaluated
export function evaluateCombatFormula(
  rules: CombatRules,
  name: string,
  inputs: readonly CombatValue[],
  onStep?: (entry: CombatTraceEntry) => void,
): CombatValue {
  let remaining = rules.limits.nodes
  const number = (value: CombatValue): number => {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error('Expected a finite calculation number')
    return value
  }
  const truth = (value: CombatValue): boolean => {
    if (typeof value === 'boolean') return value
    return number(value) !== 0
  }
  const list = (value: CombatValue): readonly CombatValue[] => {
    if (!Array.isArray(value) || value.length > rules.limits.collection)
      throw new Error('Invalid calculation collection')
    return value
  }
  const property = (value: CombatValue, key: string): CombatValue => {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
      throw new Error(`Missing calculation field: ${key}`)
    const result = (value as Readonly<Record<string, CombatValue>>)[key]!
    if (typeof result === 'number') number(result)
    if (result === undefined || typeof result === 'function' || typeof result === 'string')
      throw new Error(`Invalid calculation field: ${key}`)
    return result
  }
  const evaluate = (
    node: CombatExpression,
    scope: Readonly<Record<string, CombatValue>>,
    depth: number,
  ): CombatValue => {
    if (--remaining < 0 || depth > rules.limits.depth)
      throw new Error('Combat calculation exceeds its evaluation limit')
    if (node === null || typeof node === 'boolean') return node
    if (typeof node === 'number') return number(node)
    if (typeof node === 'string')
      return node.split('.').reduce<CombatValue>((value, key) => property(value, key), scope)
    if (!Array.isArray(node) || typeof node[0] !== 'string')
      throw new Error('Invalid combat expression')
    const [op, ...args] = node
    const arity = (count: number) => {
      if (args.length !== count) throw new Error(`Invalid arity for ${op}`)
    }
    const at = (index: number) => evaluate(args[index]!, scope, depth + 1)
    const n = (index: number) => number(at(index))
    const label = (index: number): string => {
      if (typeof args[index] !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(args[index]))
        throw new Error(`Invalid ${op} identifier`)
      return args[index]
    }
    if (op === 'if') {
      arity(3)
      return truth(at(0)) ? at(1) : at(2)
    }
    if (op === 'and' || op === 'or') {
      if (args.length < 2) throw new Error(`Invalid arity for ${op}`)
      return op === 'and' ? args.every((_, i) => truth(at(i))) : args.some((_, i) => truth(at(i)))
    }
    if (op === 'call') {
      const formula = rules.formulas[label(0)]
      if (
        !Object.hasOwn(rules.formulas, label(0)) ||
        !formula ||
        args.length !== formula.inputs.length + 1
      )
        throw new Error(`Invalid combat formula: ${String(args[0])}`)
      const local = Object.fromEntries(formula.inputs.map((input, i) => [input, at(i + 1)]))
      for (const requirement of formula.requirements ?? [])
        if (!truth(evaluate(requirement.condition, local, depth + 1)))
          throw new Error(`Invalid calculation input: ${requirement.message}`)
      for (const step of formula.steps) {
        local[step.name] = evaluate(step.value, local, depth + 1)
        onStep?.({ formula: label(0), step: step.name, value: local[step.name]! })
      }
      return evaluate(formula.result, local, depth + 1)
    }
    if (op === 'array') {
      if (args.length > rules.limits.collection) throw new Error('Invalid calculation collection')
      return args.map((_, i) => at(i))
    }
    if (op === 'field') {
      arity(3)
      const value = at(0)
      return value === null ? at(2) : property(value, label(1))
    }
    if (op === 'at') {
      arity(2)
      const index = n(1)
      if (!Number.isSafeInteger(index)) throw new Error('Invalid collection index')
      return property(list(at(0)), String(index))
    }
    if (op === 'includes') {
      arity(2)
      const needle = at(1)
      return list(at(0)).includes(needle)
    }
    if (op === 'length') {
      arity(1)
      return list(at(0)).length
    }
    if (op === 'find' || op === 'sum' || op === 'fold') {
      arity(op === 'fold' ? 6 : 3)
      const items = list(at(0)),
        itemName = label(1)
      let total: CombatValue = op === 'fold' ? at(4) : 0
      const accumulator = op === 'fold' ? label(2) : ''
      const indexName = op === 'fold' ? label(3) : ''
      for (let i = 0; i < items.length; i++) {
        const local = {
          ...scope,
          [itemName]: items[i]!,
          ...(op === 'fold' ? { [accumulator]: total, [indexName]: i } : {}),
        }
        const value = evaluate(args[op === 'fold' ? 5 : 2]!, local, depth + 1)
        if (op === 'find') {
          if (truth(value)) return items[i]!
        } else total = op === 'sum' ? number(number(total) + number(value)) : value
      }
      return op === 'find' ? null : total
    }
    if (['not', 'trunc', 'floor', 'ceil', 'abs', 'f32', 'i32'].includes(op)) {
      arity(1)
      if (op === 'not') return !truth(at(0))
      const value = n(0)
      if (op === 'i32') {
        if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647)
          throw new Error('Calculation exceeds the supported signed integer range')
        return value
      }
      if (op === 'trunc') return Math.trunc(value) || 0
      if (op === 'floor') return Math.floor(value)
      if (op === 'ceil') return Math.ceil(value)
      if (op === 'abs') return Math.abs(value)
      return number(Math.fround(value))
    }
    if (['eq', 'ne'].includes(op)) {
      arity(2)
      return op === 'eq' ? at(0) === at(1) : at(0) !== at(1)
    }
    if (['sub', 'div', 'mod', 'pow', 'lt', 'lte', 'gt', 'gte'].includes(op)) {
      arity(2)
      const a = n(0),
        b = n(1)
      if (op === 'lt') return a < b
      if (op === 'lte') return a <= b
      if (op === 'gt') return a > b
      if (op === 'gte') return a >= b
      if ((op === 'div' || op === 'mod') && b === 0) throw new Error('Calculation division by zero')
      return number(op === 'sub' ? a - b : op === 'div' ? a / b : op === 'mod' ? a % b : a ** b)
    }
    if (['add', 'mul', 'min', 'max'].includes(op)) {
      if (args.length < 2) throw new Error(`Invalid arity for ${op}`)
      const values = args.map((_, i) => n(i))
      if (op === 'min') return Math.min(...values)
      if (op === 'max') return Math.max(...values)
      return number(
        values.reduce((a, b) => number(op === 'add' ? a + b : a * b), op === 'add' ? 0 : 1),
      )
    }
    throw new Error(`Unsupported combat operator: ${op}`)
  }
  const scope = Object.fromEntries(inputs.map((value, index) => [`argument${index}`, value]))
  return evaluate(['call', name, ...inputs.map((_, index) => `argument${index}`)], scope, 0)
}
