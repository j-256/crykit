import { afterAll, describe, expect, it } from 'vitest'
import parity from '../calculations/combat-parity-v1.json'
import previewParity from '../calculations/preview-parity-v1.json'
import example from '../calculations/combat-example-v1.json'
import rules from '../calculations/combat-v1.json'
import data from '../catalog/native-combat-v1.json'
import {
  calculateCombat as calculateBundledCombat,
  COMBAT_RULES,
  traceCombat,
} from './combat-calculations'
import {
  evaluateCombatFormula,
  type CombatExpression,
  type CombatRules,
  type CombatValue,
} from './combat-expression'

const exercisedFormulas = new Set<string>()
const observedRules: CombatRules = {
  ...COMBAT_RULES,
  formulas: new Proxy(COMBAT_RULES.formulas, {
    get(target, key, receiver) {
      if (typeof key === 'string' && Object.hasOwn(target, key)) exercisedFormulas.add(key)
      return Reflect.get(target, key, receiver)
    },
  }),
}
function calculateCombat(name: string, inputs: readonly CombatValue[]): CombatValue {
  const result = evaluateCombatFormula(observedRules, name, inputs)
  expect(calculateBundledCombat(name, inputs)).toEqual(result)
  return result
}
afterAll(() => {
  const untested = Object.keys(COMBAT_RULES.formulas).filter((name) => !exercisedFormulas.has(name))
  expect(untested, 'Every bundled formula must be exercised by a native or focused test').toEqual(
    [],
  )
})

const nativeValues = parity.values as unknown as CombatValue[]
const input = (value: unknown) => value as CombatValue
const statTag = (name: string) =>
  Number(Object.entries(data.enums.SangStatModTag).find(([, label]) => label === name)![0])
const abilityMod = (name: string, value1: number, value2 = 0) => ({
  Tag: Number(Object.entries(data.enums.SangAbilityModTag).find(([, label]) => label === name)![0]),
  Value1: value1,
  Value2: value2,
})
type FixtureBattler = Omit<typeof example.user, 'Stats' | 'Statuses'> & {
  Stats: Omit<typeof example.user.Stats, 'Tags' | 'PElements'> & {
    Tags: number[]
    PElements: number[]
  }
  Statuses: { ID: number; Count: number }[]
}
const makeFixture = () =>
  structuredClone(example) as {
    user: FixtureBattler
    target: FixtureBattler
    context: typeof example.context
    ability: Omit<typeof example.ability, 'Element' | 'AbilityMods'> & {
      Element: number | null
      AbilityMods: ReturnType<typeof abilityMod>[]
    }
  }

describe('native combat parity', () => {
  it('matches every independent compiled-native vector, including full composed damage', () => {
    expect(parity.evidence.executableSha256).toBe(rules.source.executableSha256)
    for (const vector of parity.cases) {
      const args = vector.input.map((index) => nativeValues[index]!)
      expect(calculateCombat(vector.formula, args), `${vector.formula}: ${vector.label}`).toEqual(
        vector.expected,
      )
    }
  })

  it('matches independently compiled coefficient-power and physical-curve boundaries', () => {
    expect(previewParity.evidence.executableSha256).toBe(rules.source.executableSha256)
    for (const vector of previewParity.cases) expect(calculateCombat(vector.formula, vector.input as CombatValue[]), vector.formula).toEqual(vector.expected)
  })

  it('retains damage stage traces and the separately applied MP shield amount', () => {
    const fixture = makeFixture()
    fixture.target.Stats.Tags.push(statTag('MPShield'))
    const result = traceCombat('damage', [
      input(fixture.user),
      input(fixture.target),
      input(fixture.ability),
      input(fixture.context),
      false,
    ])
    const stages = result.trace.filter((step) => step.formula === 'damageModifiers')
    const before = stages.find((step) => step.step === 'inverted')!.value as number
    const after = stages.find((step) => step.step === 'shielded')!.value as number
    expect(after).toBe(Math.trunc((before * 75) / 100))
    expect(stages.find((step) => step.step === 'mpShieldReduction')!.value).toBe(after - before)
  })
})

const kernelExamples: readonly [string, CombatValue[], CombatValue][] = [
  ['percent', [-19, 15], -2],
  ['learningLP', [150], 1.5],
  ['learningWholeLP', [150], 2],
  ['learningEligible', [149, 150], false],
  ['physicalHitCurve', [1100, 1000], 96],
  ['effectiveMaximum', [1003], 1003],
  ['dotResistance', [15, 101, 30], -15],
  ['dotResistance', [-15, 101, 30], -4],
  ['dotResistance', [0, 101, 30], 0],
  ['periodicHP', [1000, 15, 0, 100, 100, 100, 100, 100, false], 135],
  ['periodicHP', [1000, -15, 0, 100, 100, 100, 100, 100, false], -165],
  ['periodicHP', [1000, 0, 100, 50, 50, 100, 999, 999, false], 25],
  ['periodicHP', [1000, 15, -200, 100, 100, 150, 100, 100, false], 0],
  ['periodicResource', [30, -15, 0, true], 0],
  ['itemConsumption', [5, true], 3],
  ['nextTurn', [49, false, false, 65], 31],
  ['nextTurn', [49, true, false, 65], 0],
  ['resourceTerm', [1000, 400, 1, 15, true, 50], 45],
  ['resourceTerm', [1000, 400, 1, -15, true, 50], -90],
  ['defenseSeed', [100], 116],
  ['repeatMultiplier', [75, 100, 3], 25],
  ['repeatMultiplier', [150, 200, 3], 200],
  ['luckFactor', [101, 101, 0], 38],
  ['luckFactor', [100, 100, 50], 75],
  ['luckChance', [15, 38, 3], 30],
  ['luckChance', [100, 50, 4], 300],
  ['difficultyHit', [99, 10], 100],
  ['difficultyHit', [0, 10], 0],
  ['difficultyHit', [100, -50], 100],
  ['rollSuccess', [30, 30], true],
  ['rollSuccess', [30, 31], false],
  ['failureCounter', [4, true], 0],
  ['failureCounter', [4, false], 5],
  ['varianceRoll', [175, [20, 121], 199], 179],
  ['varianceRoll', [0, [0], 0], 0],
  ['varianceDelta', [-100, 150], -50],
  ['statusChance', [80, false, false, true, true], 0],
  ['statusChance', [80, false, false, false, true], 80],
  ['statusDuration', [3, 2, false, false, 1, 1, 25, 25], 7],
  ['statusDuration', [255, 2, false, false, -50, 0, 0, 0], 255],
  ['statusRoll', [-1, false, true, 30, 100, 5, 31], false],
  ['statusRoll', [1, true, false, 30, 100, 5, 100], true],
  ['stealChance', [20, 50], 46],
  ['combinedStealChance', [[50, 50]], 75],
  ['escapeChance', [20, [23, 26], false], 60],
  ['escapeChance', [1, [], true], 100],
  ['assistRewardRate', [true, 100, true, 200], 200],
  ['defeatCurrencyLoss', [1000, [30, 30], 999, true], 99],
  ['difficultyStat', [101, 75], 75],
  ['difficultyVital', [101, 75], 75],
  ['difficultyVital', [101, 100], 101],
  ['difficultyVital', [105, 101], 110],
  ['applyResource', [20, 100, -200, false], 100],
  ['applyResource', [20, 100, 40, true], 20],
  ['actualResourceDamage', [20, 100, 40], 20],
  ['actualResourceDamage', [20, 100, -200], -80],
  ['spendResource', [20, 100, 40, 1, false], 1],
  ['spendResource', [20, 100, 40, 0, true], 20],
  ['accumulateAP', [27, 30, 6, 1, 150], 30],
  ['apHPRecovery', [3, 1003, true], -30],
  ['apMPRecovery', [3, true], -3],
  ['hpAlert', [1003], 501],
  ['hpCritical', [1003], 250],
  ['absorbedHP', [10, 101, 40, true], 50],
  ['absorbedHPDecay', [51, 50, true], 26],
  ['convertResourceGain', [10, 13, 1000], 13],
  ['convertResourceCost', [10, 13, 1000], 1],
  ['secondaryAttributeDamage', [101, [15, 15]], 30],
  ['statusApplicationDamage', [1003, -15, true], -150],
  ['stanceRecovery', [1003, 15], -150],
  ['threatGain', [101, 150, 25, true], 188],
  ['threatCurrentChange', [101, -50, 5], -45],
  ['threatDecay', [101, 150], 70],
  ['threatMissingHP', [400, 1003], 301],
  ['threatHealing', [50, 100, 101], 50],
  ['threatApply', [10, [-30, 15]], 0],
  ['defenseStatBonus', [100], 0],
  ['agilityRatingBonus', [100], 100],
]

describe('arithmetic boundaries and composition', () => {
  it.each(kernelExamples)('%s(%j) = %j', (name, args, expected) => {
    expect(calculateCombat(name, args)).toEqual(expected)
  })

  it('orders forced misses before NeverMiss and returns fixed chances without clamping', () => {
    const fixture = makeFixture()
    fixture.ability.AbilityMods.push(abilityMod('NeverMiss', 0))
    fixture.target.Stats.Tags.push(statTag('PEva_Always'))
    const args = [fixture.user, fixture.target, fixture.ability, fixture.context].map(input)
    expect(calculateCombat('hitChance', args)).toBe(0)
    fixture.target.Stats.Tags = []
    fixture.ability.AbilityMods = [abilityMod('FixedHitRate_100', 150)]
    expect(
      calculateCombat(
        'hitChance',
        [fixture.user, fixture.target, fixture.ability, fixture.context].map(input),
      ),
    ).toBe(150)
  })

  it('applies survival guards after randomness, without reapplying damage caps', () => {
    const fixture = makeFixture()
    fixture.target.Stats.Tags.push(statTag('CantBeOneHitKOd'))
    fixture.target.HPCurrent = fixture.target.Stats.HP
    fixture.ability.Attribute = 1
    expect(
      calculateCombat('resolvedDamage', [
        1200,
        0,
        ...[fixture.user, fixture.target, fixture.ability, fixture.context].map(input),
        1,
        0,
        0,
      ]),
    ).toBe(1002)
    fixture.target.Stats.Tags = []
    expect(
      calculateCombat('resolvedDamage', [
        100,
        50,
        ...[fixture.user, fixture.target, fixture.ability, fixture.context].map(input),
        1,
        0,
        0,
      ]),
    ).toBe(150)
  })

  it('handles ordered elements, stat-derived threat, and signed resource returns', () => {
    const fixture = makeFixture()
    fixture.ability.Element = 0
    fixture.user.Stats.PElements = [0, 1]
    expect(
      calculateCombat('elementPass', [
        101,
        [150, 150, 100, 100, 100, 100],
        input(fixture.user),
        input(fixture.ability),
      ]),
    ).toBe(201)
    expect(
      calculateCombat('threatStatBonus', [100, input(fixture.user), input(fixture.ability)]),
    ).toBe(231)
    fixture.ability.AbilityMods = [abilityMod('DamageReturnRateOverflow_100', 0, -50)]
    expect(
      calculateCombat('damageReturn', [50, 101, 0, input(fixture.user), input(fixture.ability), 0]),
    ).toBe(-50)
    fixture.user.Stats.Tags.push(statTag('DisableLifestealAndRegen'))
    expect(
      calculateCombat('damageReturn', [50, 101, 0, input(fixture.user), input(fixture.ability), 0]),
    ).toBe(0)
  })

  it('classifies healing and scope from definition, and calculates variance separately', () => {
    const fixture = makeFixture()
    expect(calculateCombat('heals', [input(fixture.ability)])).toBe(false)
    fixture.ability.BasePower = -1
    fixture.ability.Target = 1
    fixture.user.Stats.Tags.push(statTag('HealSingleToMulti'))
    expect(calculateCombat('actualScope', [input(fixture.user), input(fixture.ability)])).toBe(1)
    fixture.ability.Target = 2
    expect(calculateCombat('actualScope', [input(fixture.user), input(fixture.ability)])).toBe(0)
    expect(calculateCombat('variance', [101, input(fixture.user), input(fixture.ability)])).toBe(13)
  })
})

describe('bounded combat expression interpreter', () => {
  const evaluate = (result: CombatExpression, values: CombatValue[] = []) =>
    evaluateCombatFormula(
      {
        limits: COMBAT_RULES.limits,
        formulas: {
          test: {
            title: 'Synthetic',
            inputs: values.map((_, index) => `arg${index}`),
            steps: [],
            result,
            evidence: [],
            notes: [],
          },
        },
      },
      'test',
      values,
    )
  it('rejects missing and nonfinite inputs, invalid operations, arity, and division by zero', () => {
    for (const expr of [
      'missing',
      ['eval', 1],
      ['call', 'constructor'],
      ['add', 1],
      ['div', 1, 0],
      ['pow', -1, 0.5],
      ['at', ['array', 1], 2],
      ['field', 1, 'value', 0],
    ] as CombatExpression[])
      expect(() => evaluate(expr)).toThrow()
    expect(() => evaluate('arg0', [Infinity])).toThrow('finite')
    expect(() => evaluate('arg0.constructor', [{}])).toThrow('Missing')
    expect(() => calculateCombat('stealChance', [10, -100])).toThrow('zero')
    expect(() => calculateCombat('escapeChance', [10, [], false])).toThrow('zero')
    expect(() => evaluate(['i32', 2147483648])).toThrow('signed integer')
    expect(() => evaluate(['i32', -2147483649])).toThrow('signed integer')
    expect(() => evaluate(['i32', 1.5])).toThrow('signed integer')
    expect(() => calculateCombat('percent', [2147483647, 100])).toThrow('signed integer')
  })
  it('requires valid random draws and resource selectors instead of guessing inputs', () => {
    for (const roll of [0, 101, 1.5])
      expect(() => calculateCombat('rollSuccess', [50, roll])).toThrow('Invalid calculation input')
    for (const args of [
      [-1, [50], 50],
      [100, [50], 50],
      [0, [50, 60], 50],
      [0, [201], 50],
      [0, [50.5], 50],
      [0, [50], -1],
    ] as CombatValue[][])
      expect(() => calculateCombat('varianceRoll', args)).toThrow('Invalid calculation input')
    expect(() => calculateCombat('resourceTerm', [100, 50, 3, 10, false, 100])).toThrow(
      'Invalid calculation input',
    )
  })
  it('evaluates only selected conditional branches and uses lexical collection scopes', () => {
    expect(evaluate(['if', true, 2, ['div', 1, 0]])).toBe(2)
    expect(evaluate(['and', false, ['div', 1, 0]])).toBe(false)
    expect(
      evaluate(['sum', ['array', 1, 2], 'n', ['sum', ['array', 3, 4], 'm', ['mul', 'n', 'm']]]),
    ).toBe(21)
    expect(
      evaluate([
        'fold',
        ['array', 3, 4],
        'item',
        'acc',
        'index',
        1,
        ['add', 'acc', 'item', 'index'],
      ]),
    ).toBe(9)
  })
  it('rejects excessive depth, collection size, and cyclic formula calls', () => {
    let deep: CombatExpression = 0
    for (let i = 0; i < COMBAT_RULES.limits.depth + 1; i++) deep = ['add', 0, deep]
    expect(() => evaluate(deep)).toThrow('limit')
    expect(() =>
      evaluate(
        ['sum', 'arg0', 'item', 'item'],
        [Array(COMBAT_RULES.limits.collection + 1).fill(1)],
      ),
    ).toThrow('collection')
    const cyclic: CombatRules = {
      limits: COMBAT_RULES.limits,
      formulas: {
        test: {
          title: 'Synthetic',
          inputs: [],
          steps: [],
          result: ['call', 'test'],
          evidence: [],
          notes: [],
        },
      },
    }
    expect(() => evaluateCombatFormula(cyclic, 'test', [])).toThrow('limit')
  })
})
