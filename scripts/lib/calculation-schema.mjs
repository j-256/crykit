const ref = (name) => ({ $ref: `#/$defs/${name}` })
const identifier = { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]*$' }
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const list = (items) => ({ type: 'array', items })
const text = { type: 'string' }
const integer = { type: 'integer' }
const node = (names, args, rest) => ({
  type: 'array',
  prefixItems: [{ enum: names }, ...args],
  minItems: args.length + 1,
  ...(rest ? { items: rest, maxItems: 10001 } : { items: false, maxItems: args.length + 1 }),
})

export function buildCalculationSchema(characterSchema) {
  // The character component supplies fields and definitions, never a standalone export format
  const nativeProperties = characterSchema.properties
  const expression = ref('combatExpression')
  const value = ref('combatValue')
  const definitions = {
    combatExpression: {
      anyOf: [
        { type: ['number', 'boolean', 'null', 'string'] },
        ...[
          node(['if'], [expression, expression, expression]),
          node(['not', 'trunc', 'floor', 'ceil', 'abs', 'f32', 'i32', 'length'], [expression]),
          node(
            ['sub', 'div', 'mod', 'pow', 'lt', 'lte', 'gt', 'gte', 'eq', 'ne', 'at', 'includes'],
            [expression, expression],
          ),
          node(['add', 'mul', 'min', 'max', 'and', 'or'], [expression, expression], expression),
          node(['array'], [], expression),
          node(['call'], [identifier], expression),
          node(['field'], [expression, identifier, expression]),
          node(['find', 'sum'], [expression, identifier, expression]),
          node(['fold'], [expression, identifier, identifier, identifier, expression, expression]),
        ],
      ],
    },
    combatValue: {
      anyOf: [
        { type: ['number', 'boolean', 'null'] },
        list(value),
        { type: 'object', additionalProperties: value },
      ],
    },
    combatFormula: object(
      {
        title: text,
        inputs: list(identifier),
        steps: list(object({ name: identifier, value: expression })),
        result: expression,
        evidence: list(text),
        notes: list(text),
        requirements: list(object({ condition: expression, message: text })),
      },
      ['title', 'inputs', 'steps', 'result', 'evidence', 'notes'],
    ),
    combatRules: object({
      schemaVersion: { const: 1 },
      id: { const: 'pc-1.6.9-combat-v1' },
      source: { type: 'object' },
      limits: object({ depth: integer, nodes: integer, collection: integer }),
      semantics: { type: 'object', additionalProperties: text },
      operators: { type: 'object', additionalProperties: text },
      contracts: { type: 'object', additionalProperties: text },
      coverage: { type: 'object' },
      curveTables: {
        type: 'object',
        additionalProperties: list({
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
        }),
      },
      formulas: { type: 'object', additionalProperties: ref('combatFormula') },
    }),
    combatVerification: object({
      schemaVersion: { const: 1 },
      engine: { const: 'pc-1.6.9-combat-v1' },
      evidence: { type: 'object' },
      values: list(value),
      cases: list(
        object({
          label: text,
          formula: identifier,
          input: list({ type: 'integer', minimum: 0 }),
          expected: value,
        }),
      ),
    }),
    previewVerification: object({
      schemaVersion: { const: 1 },
      evidence: { type: 'object' },
      cases: list(object({ formula: identifier, input: list(value), expected: value })),
    }),
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:crykit:calculation-package:1',
    title: 'Crystal Project character, combat, and effective modifier calculation package',
    description: 'Portable rules and numeric inputs; describes export structure and arithmetic syntax, not permission to execute imported rules',
    type: 'object',
    properties: {
      format: { const: 'crystal-project-calculations' },
      schemaVersion: { const: 1 },
      id: { const: 'crystal-project-calculations-v1' },
      ...nativeProperties,
      combat: ref('combatRules'),
      combatData: object({
        schemaVersion: { const: 1 },
        engine: { const: 'pc-1.6.9-combat-v1' },
        source: { type: 'object' },
        nativeDataDigest: text,
        enums: { type: 'object' },
        records: { type: 'object' },
        patches: list({ type: 'object' }),
        checksum: text,
      }),
      combatVerification: ref('combatVerification'),
      previewVerification: ref('previewVerification'),
      example: object({ user: value, target: value, ability: value, context: value }),
      enemy: { type: 'object' },
      modifiers: object({
        schemaVersion: { const: 1 },
        engine: { const: 'pc-1.6.9-v1' },
        executableSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        evidence: text,
        sourceFiles: { type: 'object', additionalProperties: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
        defaults: { type: 'object', additionalProperties: { type: ['number', 'null'] } },
        operations: { type: 'object', additionalProperties: list(object({ field: text, operation: { enum: ['add', 'multiply', 'percent', 'level', 'turn', 'repeatCap'] } })) },
      }),
      modifierVerification: object({
        schemaVersion: { const: 1 },
        engine: { const: 'pc-1.6.9-v1' },
        evidence: { type: 'object' },
        cases: list(object({ name: text, level: integer, turnCount: integer, records: list({ type: 'object' }), expected: { type: 'object' } })),
      }),
    },
    required: [
      'format',
      'schemaVersion',
      'id',
      ...characterSchema.required,
      'combat',
      'combatData',
      'combatVerification',
      'previewVerification',
      'example',
      'enemy',
      'modifiers',
      'modifierVerification',
    ],
    additionalProperties: false,
    $defs: { ...characterSchema.$defs, ...definitions },
  }
}
