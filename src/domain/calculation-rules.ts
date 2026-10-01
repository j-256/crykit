import rulesData from '../calculations/pc-1.6.9-v1.json' with { type: 'json' }
import nativeData from '../catalog/native-stats-v1.json' with { type: 'json' }
import guideData from '../calculations/guide-v1.json' with { type: 'json' }
import parityData from '../calculations/pc-parity-v1.json' with { type: 'json' }

export type Expression = number | string | readonly Expression[]
export interface Formula {
  readonly inputs: readonly string[]
  readonly steps: readonly { readonly name: string; readonly value: Expression }[]
  readonly result: Expression
  readonly evidence: string
}
export interface CalculationRules {
  readonly id: 'pc-1.6.9-v1'
  readonly limits: { readonly levelCap: number; readonly expressionDepth: number; readonly expressionNodes: number }
  readonly coreStats: readonly string[]
  readonly stats: Readonly<Record<string, { readonly rating?: string; readonly gender?: string; readonly formula?: string; readonly min: number; readonly max?: number; readonly base?: number }>>
  readonly formulas: Readonly<Record<string, Formula>>
  readonly sheetStages: readonly { readonly stat: string; readonly value: Expression }[]
  readonly statMods: Readonly<Record<string, { readonly name: string; readonly stat?: string; readonly kind: string; readonly scale?: string; readonly scope: 'sheet' | 'battle' | 'permission' | 'context' }>>
  readonly modifierDefaults: { readonly flat: number; readonly percent: number; readonly tt: number; readonly hp: number }
  readonly genders: { readonly male: number; readonly female: number }
  readonly equipment: { readonly weaponTypes: readonly number[]; readonly pairedTag: number; readonly secondaryInnatesTag: number }
  readonly contexts: { readonly turnCount: number }
  readonly benchmarks: readonly { readonly id: string; readonly label: string; readonly attack: string; readonly main: string; readonly pierce: string; readonly basePower: number; readonly attackRate: number; readonly statRate: number; readonly targetMain: number; readonly defense: number }[]
}
export const PC_RULES = rulesData as unknown as CalculationRules
export const PC_MODEL = PC_RULES.id
export const PC_LEVEL_CAP = PC_RULES.limits.levelCap
export const NATIVE_DATA = nativeData
export const GUIDE_RULES = guideData as unknown as Omit<typeof guideData, 'formulas'> & { readonly formulas: Readonly<Record<string, Formula>> }
type ArithmeticRules = { readonly limits: Pick<CalculationRules['limits'], 'expressionDepth' | 'expressionNodes'>; readonly formulas: CalculationRules['formulas'] }

function roundEven(value: number): number {
  const floor = Math.floor(value)
  const fraction = value - floor
  return fraction === 0.5 ? floor % 2 === 0 ? floor : floor + 1 : Math.round(value)
}

export function evaluateExpression(expression: Expression, variables: Readonly<Record<string, number>>, rules: ArithmeticRules = PC_RULES): number {
  let remaining = rules.limits.expressionNodes
  const evaluate = (node: Expression, scope: Readonly<Record<string, number>>, depth: number): number => {
    if (--remaining < 0 || depth > rules.limits.expressionDepth) throw new Error('Calculation expression exceeds its evaluation limit')
    if (typeof node === 'number') return checked(node)
    if (typeof node === 'string') {
      if (!Object.hasOwn(scope, node)) throw new Error(`Missing calculation input: ${node}`)
      return checked(scope[node]!)
    }
    if (!Array.isArray(node) || typeof node[0] !== 'string') throw new Error('Invalid calculation expression')
    const [operator, ...args] = node
    const arity = (count: number) => { if (args.length !== count) throw new Error(`Invalid arity for ${operator}`) }
    const at = (index: number) => evaluate(args[index]!, scope, depth + 1)
    if (operator === 'if') { arity(3); return at(0) !== 0 ? at(1) : at(2) }
    if (operator === 'and') { arity(2); return at(0) !== 0 && at(1) !== 0 ? 1 : 0 }
    if (operator === 'call') {
      const name = args[0]
      const formula = typeof name === 'string' && Object.hasOwn(rules.formulas, name) ? rules.formulas[name] : undefined
      if (!formula || args.length !== formula.inputs.length + 1) throw new Error(`Invalid formula call: ${String(name)}`)
      const local: Record<string, number> = Object.fromEntries(formula.inputs.map((input, index) => [input, at(index + 1)]))
      for (const step of formula.steps) local[step.name] = evaluate(step.value, local, depth + 1)
      return evaluate(formula.result, local, depth + 1)
    }
    if (['trunc', 'roundEven', 'floor', 'ceil'].includes(operator)) {
      arity(1)
      const value = at(0)
      return operator === 'trunc' ? Math.trunc(value) : operator === 'floor' ? Math.floor(value) : operator === 'ceil' ? Math.ceil(value) : roundEven(value)
    }
    if (['sub', 'div', 'pow', 'lte', 'eq'].includes(operator)) {
      arity(2)
      const a = at(0), b = at(1)
      if (operator === 'sub') return checked(a - b)
      if (operator === 'div') { if (b === 0) throw new Error('Calculation division by zero'); return checked(a / b) }
      if (operator === 'pow') return checked(a ** b)
      if (operator === 'eq') return a === b ? 1 : 0
      return a <= b ? 1 : 0
    }
    if (args.length < 2) throw new Error(`Invalid arity for ${operator}`)
    const values = args.map((_, index) => at(index))
    if (operator === 'add') return checked(values.reduce((a, b) => a + b, 0))
    if (operator === 'mul') return checked(values.reduce((a, b) => a * b, 1))
    if (operator === 'min') return Math.min(...values)
    if (operator === 'max') return Math.max(...values)
    throw new Error(`Unsupported calculation operator: ${operator}`)
  }
  return evaluate(expression, variables, 0)
}

function checked(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Calculation input or result is not finite')
  return value
}

export function calculateFormula(name: string, inputs: readonly number[], rules: ArithmeticRules = PC_RULES): number {
  return evaluateExpression(['call', name, ...inputs], {}, rules)
}

export function calculationPackage() {
  return { format: 'crystal-project-calculations', schemaVersion: 1, id: PC_MODEL, rules: rulesData, data: nativeData, legacy: guideData, verification: parityData }
}
