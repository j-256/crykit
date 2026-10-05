import { readFileSync } from 'node:fs'

const infix = {
  add: '+',
  sub: '-',
  mul: '*',
  div: '/',
  mod: '%',
  pow: '^',
  eq: '=',
  ne: '!=',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
  and: 'and',
  or: 'or',
}
const labels = {
  memberHP: 'Base HP',
  memberMP: 'Base MP',
  memberCore: 'Base attribute',
  critChance: 'Attribute-derived critical chance',
  critDamage: 'Attribute-derived extra critical damage',
  penetration: 'Attribute-derived penetration',
  turnTime: 'Speed-derived turn time',
  unarmedAttack: 'Unarmed attack bonus',
  twoHandedAttack: 'Two-Handed attack bonus',
  defenseSeed: 'Defense seed',
  defenseRate: 'Benchmark defense multiplier',
  benchmarkDamage: 'Isolated damage benchmark',
}
const anchor = (id) => id.toLowerCase()

export function renderExpression(expression, enums = {}) {
  if (!Array.isArray(expression)) return expression === null ? 'none' : String(expression)
  const [op, ...args] = expression
  const render = (value) => renderExpression(value, enums)
  if (op === 'i32') return render(args[0])
  if (
    op === 'includes' &&
    typeof args[0] === 'string' &&
    args[0].endsWith('.Stats.Tags') &&
    typeof args[1] === 'number'
  )
    return `${args[0].split('.')[0]} has ${enums.SangStatModTag?.[args[1]] ?? args[1]}`
  if (
    op === 'find' &&
    args[0] === 'ability.AbilityMods' &&
    JSON.stringify(args[2]?.slice(0, 2)) === JSON.stringify(['eq', 'mod.Tag'])
  )
    return `ability modifier ${enums.SangAbilityModTag?.[args[2][2]] ?? args[2][2]}`
  if (op === 'field') return `${render(args[0])}.${args[1]} (if record is none: ${render(args[2])})`
  if (infix[op]) return `(${args.map(render).join(` ${infix[op]} `)})`
  if (op === 'if') return `if ${render(args[0])} then ${render(args[1])} else ${render(args[2])}`
  if (op === 'call') return `${args[0]}(${args.slice(1).map(render).join(', ')})`
  if (op === 'array') return `[${args.map(render).join(', ')}]`
  if (op === 'at') return `${render(args[0])}[${render(args[1])}]`
  if (op === 'sum') return `sum(${render(args[0])}, for each ${args[1]}: ${render(args[2])})`
  if (op === 'find') return `first(${render(args[0])}, where ${args[1]}: ${render(args[2])})`
  if (op === 'fold')
    return `fold(${render(args[0])}, start ${args[2]} = ${render(args[4])}; for each ${args[1]} at ${args[3]}: ${render(args[5])})`
  return `${op}(${args.map(render).join(', ')})`
}

function assignment(name, expression, enums, indent = '') {
  if (Array.isArray(expression) && expression[0] === 'if')
    return `${indent}if ${renderExpression(expression[1], enums)}:\n${assignment(name, expression[2], enums, indent + '  ')}\n${indent}else:\n${assignment(name, expression[3], enums, indent + '  ')}`
  return `${indent}${name} = ${renderExpression(expression, enums)}`
}

const overview = readFileSync(new URL('./calculation-reference-intro.md', import.meta.url), 'utf8')
const inline = (value) => String.fromCharCode(96) + value + String.fromCharCode(96)
const codeBlock = (value) =>
  String.fromCharCode(96).repeat(3) + 'text\n' + value + '\n' + String.fromCharCode(96).repeat(3)

function formulaSection(section, id, formula, enums) {
  const equations = [
    ...formula.steps.map((step) => assignment(step.name, step.value, enums)),
    assignment('result', formula.result, enums),
  ].join('\n')
  return [
    '<a id="' + section.id + '-' + anchor(id) + '"></a>',
    '### ' + (formula.title ?? labels[id] ?? id),
    'Formula ID: ' +
      inline(id) +
      '. Inputs, in order: ' +
      (formula.inputs.map(inline).join(', ') || 'none') +
      '.',
    ...(formula.notes?.length ? [formula.notes.join(' ')] : []),
    ...(formula.requirements?.length
      ? ['Input requirements: ' + formula.requirements.map((rule) => rule.message).join('; ') + '.']
      : []),
    codeBlock(equations),
  ].join('\n\n')
}

export function buildCalculationReference({ rules, combat, combatData, example, modifiers }) {
  const sections = [
    { id: 'sheet', title: 'Character-sheet equations', formulas: rules.formulas },
    { id: 'combat', title: 'Combat equations', formulas: combat.formulas },
  ]
  const index = sections
    .map((section) =>
      [
        '### ' + section.title,
        Object.entries(section.formulas)
          .map(
            ([id, formula]) =>
              '- [' +
              (formula.title ?? labels[id] ?? id) +
              '](#' +
              section.id +
              '-' +
              anchor(id) +
              ')',
          )
          .join('\n'),
      ].join('\n\n'),
    )
    .join('\n\n')
  const body = sections
    .map((section) =>
      [
        '## ' + section.title,
        ...Object.entries(section.formulas).map(([id, formula]) =>
          formulaSection(section, id, formula, combatData.enums),
        ),
      ].join('\n\n'),
    )
    .join('\n\n')
  const stages = rules.sheetStages
    .map(
      (step, index) => index + 1 + '. ' + inline(step.stat + ' = ' + renderExpression(step.value)),
    )
    .join('\n')
  const curves = Object.entries(combat.curveTables)
    .map(([id, points]) =>
      [
        '### ' + id,
        [
          '| Input | Value |',
          '| --- | --- |',
          ...points.map(([x, y]) => '| ' + x + ' | ' + y + ' |'),
        ].join('\n'),
      ].join('\n\n'),
    )
    .join('\n\n')
  return (
    [
      overview.trimEnd(),
      '## Formula index',
      index,
      '## Input contracts',
      ...Object.entries(combat.contracts).map(
        ([name, description]) => '### ' + name + '\n\n' + description,
      ),
      'The exported ' +
        inline('example') +
        ' is an explicitly synthetic complete input fixture. It has ' +
        example.user.Stats.HP +
        ' maximum HP, ' +
        example.user.Stats.Str +
        ' Strength, and ' +
        example.user.Stats.PAtk +
        ' ATK; it is not a real character or recommendation.',
      body,
      ...(modifiers ? [
        '## Effective modifier aggregation',
        'Aggregate equipment, class innates and equipped passives, and active statuses in separate groups. Start each group with the native neutral defaults below. Apply each modifier in source order with integer truncation, then merge equipment, passives and statuses in that order. Multipliers merge by truncated multiplication divided by 100; flat and additive values merge by addition. Nullable damage caps select the smaller present cap; nullable status limits add their present values. The modifier verification fixtures compare these operations against unchanged compiled native methods.',
        '### Native neutral defaults',
        ['| Field | Neutral value |', '| --- | --- |', ...Object.entries(modifiers.defaults).map(([field, value]) => '| ' + inline(field) + ' | ' + (value === null ? 'No limit' : value) + ' |')].join('\n'),
        '### Scalar modifier operations',
        'Here v1 and v2 are the typed modifier values. add adds v1; multiply multiplies by v1 / 100; percent multiplies by (100 + v1) / 100; level adds v1 * level / v2; turn adds v1 * min(turn, v2); repeatCap multiplies by (100 + v1 * v2) / 100. Every division truncates toward zero. Invalid or unavailable inputs remain unresolved only for the affected fields and their dependent calculations.',
        ['| Modifier | Native field | Operation |', '| --- | --- | --- |', ...Object.entries(modifiers.operations).flatMap(([tag, operations]) => operations.map(operation => '| ' + inline(tag) + ' | ' + inline(operation.field) + ' | ' + inline(operation.operation) + ' |'))].join('\n'),
        'Ability-specific damage and element modifiers start at 100 and multiply by (100 + v2) / 100 for identity v1. Ability-specific MP and AP costs start at zero and add v2 for identity v1. Group merging uses multiplication for damage and elements and addition for costs. Resource-return modifiers select HP, MP, or AP with v1 and add v2; healing return also supports the matching ability resource. Boolean tags and physical elements form unions; status immunity declarations remain explicit. Automatic statuses are separate from resting stats and require an explicit battle snapshot. Chance, life state, immunity, application history, and finite-duration uncertainty constrain their inclusion.',
      ] : []),
      '## Ordered character-sheet stages',
      'Apply these after the source-group modifiers have been collected as specified in the package guide. Order is significant; later stages use updated values.',
      stages,
      '## Curve tables',
      'Tables clamp outside their endpoints and use curveSegment between adjacent keys.',
      curves,
      '## Machine operator reference',
      Object.entries(combat.operators)
        .map(([name, description]) => '- ' + inline(name) + ': ' + description)
        .join('\n'),
      'This file is generated by ' +
        inline('npm run calculations:reference') +
        '. Edit the authored rule definitions or reference renderer, then regenerate; ' +
        inline('npm run calculations:check') +
        ' rejects drift.',
    ].join('\n\n') + '\n'
  )
}
