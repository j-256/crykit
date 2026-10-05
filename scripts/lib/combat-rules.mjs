// Authored arithmetic definitions; the exporter serializes these expressions as data
const op = (name, ...args) => [name, ...args]
const add = (...a) => op('i32', op('add', ...a)),
  sub = (a, b) => op('i32', op('sub', a, b)),
  mul = (...a) => op('i32', op('mul', ...a))
const div = (a, b) => op('div', a, b),
  trunc = (a) => op('trunc', a),
  pct = (a, b) => trunc(div(mul(a, b), 100))
const min = (...a) => op('min', ...a),
  max = (...a) => op('max', ...a),
  clamp = (x, lo, hi) => min(hi, max(lo, x))
const iff = (c, a, b) => op('if', c, a, b),
  eq = (a, b) => op('eq', a, b),
  ne = (a, b) => op('ne', a, b)
const gt = (a, b) => op('gt', a, b),
  ge = (a, b) => op('gte', a, b),
  lt = (a, b) => op('lt', a, b),
  le = (a, b) => op('lte', a, b)
const and = (...a) => op('and', ...a),
  or = (...a) => op('or', ...a),
  not = (a) => op('not', a)
const call = (name, ...a) => op('call', name, ...a),
  array = (...a) => op('array', ...a),
  at = (a, i) => op('at', a, i)
const sum = (a, name, expr) => op('sum', a, name, expr),
  fold = (a, seed, expr) => op('fold', a, 'item', 'acc', 'index', seed, expr)
const find = (a, name, expr) => op('find', a, name, expr),
  field = (a, name, fallback = 0) => op('field', a, name, fallback)
const f32 = (a) => op('f32', a),
  fadd = (a, b) => f32(op('add', a, b)),
  fsub = (a, b) => f32(op('sub', a, b)),
  fmul = (a, b) => f32(op('mul', a, b)),
  fdiv = (a, b) => f32(div(a, b))
const core = ['Str', 'Vit', 'Dex', 'Agi', 'Mnd', 'Spi', 'Spd', 'Lck']
const common = ['user', 'target', 'ability', 'context']
const calc = (name) => `Sang.Battle.Calculator.${name}`
const abilitySource = (name) => `Sang.SangData.HAbility.${name}`

export function buildCombatRules(native) {
  const enums = Object.fromEntries(
    Object.entries(native.enums).map(([name, values]) => [
      name,
      Object.fromEntries(Object.entries(values).map(([id, label]) => [label, Number(id)])),
    ]),
  )
  const statTag = (name) => {
    if (!Object.hasOwn(enums.SangStatModTag, name)) throw new Error(`Unknown stat tag ${name}`)
    return enums.SangStatModTag[name]
  }
  const abilityTag = (name) => {
    if (!Object.hasOwn(enums.SangAbilityModTag, name))
      throw new Error(`Unknown ability tag ${name}`)
    return enums.SangAbilityModTag[name]
  }
  const tag = (who, name) => op('includes', `${who}.Stats.Tags`, statTag(name))
  const mod = (name) => find('ability.AbilityMods', 'mod', eq('mod.Tag', abilityTag(name)))
  const has = (name) => ne(mod(name), null)
  const value = (name, n = 1, fallback = 0) => field(mod(name), `Value${n}`, fallback)
  const statusCount = (who, id) =>
    field(find(`${who}.Statuses`, 'status', eq('status.ID', id)), 'Count')
  const pairValue = (list, id, fallback) =>
    field(find(list, 'pair', eq('pair.ID', id)), 'Value', fallback)
  const formulas = {}
  const rule = (id, title, inputs, steps, result, evidence, notes = []) => {
    if (formulas[id]) throw new Error(`Duplicate rule ${id}`)
    formulas[id] = {
      title,
      inputs,
      steps: steps.map(([name, value]) => ({ name, value })),
      result,
      evidence: Array.isArray(evidence) ? evidence : [evidence],
      notes,
    }
  }
  const simple = (id, title, inputs, result, evidence, notes = []) =>
    rule(id, title, inputs, [], result, evidence, notes)

  simple('learningLP', 'LP cost displayed in the native learn tree', ['jp'], div('jp', 100), 'Sang.Window.Field.Learn.WindowLearnAbilitySelect.Draw', ['Fractional costs display two decimal places; stored costs and affordability use exact JP.'])
  simple('learningWholeLP', 'Whole LP sufficient for a JP cost', ['jp'], op('ceil', div('jp', 100)), 'Sang.Window.Field.Learn.WindowLearnAbilitySelect.UpdateInput', ['A conversion for whole LP input, not a rounded game cost.'])
  simple('learningEligible', 'JP affordability before learning prerequisites', ['currentJP', 'costJP'], ge('currentJP', 'costJP'), 'Sang.Window.Field.Learn.WindowLearnAbilitySelect.UpdateInput', ['Learning also requires unlocked skills and satisfied prerequisites.'])
  simple(
    'percent',
    'Apply a percentage, truncating toward zero',
    ['amount', 'rate'],
    pct('amount', 'rate'),
    calc('CalculateDamage'),
    [
      'Rates are percentage points: 100 means unchanged, 0 means zero. Truncate every division where shown, including negative healing values.',
    ],
  )
  simple(
    'effectiveMaximum',
    'Maximum resource used by periodic effects',
    ['maximum'],
    'maximum',
    ['HP', 'MP', 'AP'].map((resource) => calc(`CalculateEffectiveDamagePerTurnMax${resource}`)),
  )
  simple(
    'dotResistance',
    'Vitality and Spirit adjustment to periodic HP',
    ['rate', 'vitality', 'spirit'],
    iff(
      gt('rate', 0),
      sub(0, pct('vitality', 'rate')),
      iff(lt('rate', 0), pct('spirit', 'rate'), 0),
    ),
    calc('CalculateDamagePerTurnResistance'),
    [
      'Positive rates damage HP; negative rates restore HP. Vitality reduces percentage DoT. Spirit increases percentage regeneration received. Neither stat changes flat-only periodic effects through this rule.',
    ],
  )
  rule(
    'periodicHP',
    'HP damage or regeneration per tick',
    [
      'maximum',
      'rate',
      'flat',
      'percentDamageMultiplier',
      'damageOverTimeMultiplier',
      'healingOverTimeMultiplier',
      'vitality',
      'spirit',
      'disableRecovery',
    ],
    [
      ['base', add(pct('maximum', 'rate'), 'flat')],
      [
        'modified',
        iff(
          gt('base', 0),
          pct(pct('base', 'percentDamageMultiplier'), 'damageOverTimeMultiplier'),
          iff(lt('base', 0), pct('base', 'healingOverTimeMultiplier'), 'base'),
        ),
      ],
      ['resisted', add('modified', call('dotResistance', 'rate', 'vitality', 'spirit'))],
      ['bounded', iff(gt('rate', 0), max(0, 'resisted'), 'resisted')],
    ],
    iff(and('disableRecovery', lt('bounded', 0)), 0, 'bounded'),
    'Sang.Battle.AbilityProcessor.ResolveDamagePerTurn',
    [
      'Sum the active flat and additive-rate effects first. Multipliers affect the combined base, before Vitality/Spirit. Positive-rate damage cannot become healing. No hit roll, critical, direct-damage defense, or variance is applied. Apply the returned signed amount with applyResource.',
    ],
  )
  simple(
    'periodicResource',
    'MP or AP periodic change',
    ['maximum', 'rate', 'flat', 'disableRecovery'],
    iff(
      'disableRecovery',
      max(0, add(pct('maximum', 'rate'), 'flat')),
      add(pct('maximum', 'rate'), 'flat'),
    ),
    'Sang.Battle.AbilityProcessor.ResolveDamagePerTurn',
    ['MP and AP do not receive HP periodic multipliers or Vitality/Spirit adjustments.'],
  )
  simple(
    'heals',
    'Classify an ability as healing',
    ['ability'],
    or(
      lt('ability.BasePower', 0),
      lt('ability.BasePAtkRate', 0),
      and(ne('ability.ScalingPower', null), lt('ability.ScalingPower', 0)),
      and(ne('ability.ScalingPAtkRate', null), lt('ability.ScalingPAtkRate', 0)),
      ne(
        find(
          'ability.AbilityMods',
          'mod',
          and(
            op(
              'includes',
              array(
                ...[
                  'DamageRateUserCurrent_100',
                  'DamageRateUserMissing_100',
                  'DamageRateUserMax_100',
                  'DamageRateCurrent_100',
                  'DamageRateMissing_100',
                  'DamageRateMax_100',
                ].map(abilityTag),
              ),
              'mod.Tag',
            ),
            lt('mod.Value1', 0),
          ),
        ),
        null,
      ),
    ),
    abilitySource('Heals'),
    [
      'Healing classification uses the ability definition, not the sign of its final damage. A mixed-sign ability can be classified as healing.',
    ],
  )
  simple(
    'actualScope',
    'Effective single or multi-target scope',
    ['user', 'ability'],
    iff(
      and(
        eq('ability.Scope', 0),
        or(
          tag('user', 'TargetMulti'),
          and(
            call('heals', 'ability'),
            not(op('includes', array(2, 4, 6), 'ability.Target')),
            tag('user', 'HealSingleToMulti'),
          ),
        ),
      ),
      1,
      iff(and(tag('user', 'TargetSingleWithBonus'), ne('ability.Scope', 0)), 0, 'ability.Scope'),
    ),
    abilitySource('GetActualScope'),
  )
  simple(
    'hpCost',
    'HP cost',
    ['user', 'ability'],
    max(0, pct(pct('user.Stats.HP', 'ability.HPCost'), 'user.Stats.PercentDmgTakenMult')),
    abilitySource('CalculateAbilityFlatHPCost'),
  )
  for (const resource of ['MP', 'AP'])
    simple(
      `${resource.toLowerCase()}Cost`,
      `${resource} cost`,
      ['user', 'ability'],
      iff(
        resource === 'AP' ? and(eq('ability.ID', 45), tag('user', 'EscapeCostDown')) : false,
        0,
        pct(
          max(
            0,
            add(
              `ability.${resource}Cost`,
              `user.Stats.${resource}CostsFlat`,
              pairValue(`user.Stats.Ability${resource}CostFlat`, 'ability.ID', 0),
            ),
          ),
          `user.Stats.${resource}CostsMult`,
        ),
      ),
      abilitySource(`CalculateAbility${resource}Cost`),
      [
        'Use the first matching per-ability cost entry. Clamp the flat subtotal before multiplying, not afterward.',
      ],
    )
  simple(
    'chargeTime',
    'Charge time',
    ['user', 'ability'],
    iff(tag('user', 'InstantCT'), 0, pct('ability.CTCost', 'user.Stats.CTMult')),
    abilitySource('CalculateAbilityCTCost'),
  )
  rule(
    'cooldown',
    'Cooldown after an ability',
    ['user', 'ability'],
    [
      [
        'base',
        iff(
          gt('ability.CDCost', 0),
          add('ability.CDCost', 'user.Stats.CooldownsFlat'),
          'ability.CDCost',
        ),
      ],
      [
        'halved',
        iff(
          and(gt('ability.CDCost', 0), tag('user', 'HalfCooldowns')),
          trunc(div('base', 2)),
          'base',
        ),
      ],
      ['removed', iff(and(gt('ability.CDCost', 0), tag('user', 'NoCooldowns')), 0, 'halved')],
      [
        'limited',
        iff(
          and(gt('ability.CDCost', 0), tag('user', 'CooldownsTo1')),
          min('removed', 1),
          'removed',
        ),
      ],
    ],
    max(0, 'limited'),
    abilitySource('CalculateAbilityCooldown'),
  )
  simple(
    'itemConsumption',
    'Item consumption',
    ['baseCount', 'halved'],
    iff('halved', op('ceil', div('baseCount', 2)), 'baseCount'),
    abilitySource('CalculateAbilityItemConsumptionCount'),
  )
  simple(
    'nextTurn',
    'Time until the next turn',
    ['turnTime', 'freeAction', 'instantTurn', 'abilityMultiplier'],
    iff(or('freeAction', 'instantTurn'), 0, pct('turnTime', 'abilityMultiplier')),
    'Sang.Battle.HTurn.GetNextTurnTT',
    [
      'Pass 100 when the ability has no NextTurnTTMult_100 modifier. Free actions and InstantTT bypass the ordinary turn-time minimum.',
    ],
  )

  simple(
    'resourceTerm',
    'Percentage-resource contribution to base damage',
    ['maximum', 'current', 'mode', 'rate', 'targetHP', 'percentDamageMultiplier'],
    iff(
      and(
        'targetHP',
        gt(
          pct(
            iff(eq('mode', 0), 'current', iff(eq('mode', 1), sub('maximum', 'current'), 'maximum')),
            'rate',
          ),
          0,
        ),
      ),
      pct(
        pct(
          iff(eq('mode', 0), 'current', iff(eq('mode', 1), sub('maximum', 'current'), 'maximum')),
          'rate',
        ),
        'percentDamageMultiplier',
      ),
      pct(
        iff(eq('mode', 0), 'current', iff(eq('mode', 1), sub('maximum', 'current'), 'maximum')),
        'rate',
      ),
    ),
    calc('CalculateBaseAttack'),
    [
      'Mode 0 is current, 1 missing, 2 maximum. Only positive contributions from the target HP pool receive PercentDmgTakenMult. User resource terms do not.',
    ],
  )
  const resourceTerms = []
  for (const [suffix, mode] of [
    ['Current', 0],
    ['Missing', 1],
    ['Max', 2],
  ])
    for (const who of ['target', 'user']) {
      const name = `DamageRate${who === 'user' ? 'User' : ''}${suffix}_100`
      resourceTerms.push([abilityTag(name), who, mode])
    }
  let resourceExpr = 0
  for (const [id, who, mode] of resourceTerms.toReversed()) {
    let amount = 0
    for (const [resource, attr] of [
      ['HP', 0],
      ['MP', 1],
      ['AP', 2],
    ].toReversed())
      amount = iff(
        eq(iff(eq('mod.Value2', 6), 'ability.Attribute', 'mod.Value2'), attr),
        call(
          'resourceTerm',
          mode === 0 ? 0 : `${who}.Stats.${resource}`,
          mode === 2 ? 0 : `${who}.${resource}Current`,
          mode,
          'mod.Value1',
          who === 'target' && attr === 0,
          who === 'target' && attr === 0 ? `${who}.Stats.PercentDmgTakenMult` : 100,
        ),
        amount,
      )
    resourceExpr = iff(eq('mod.Tag', id), amount, resourceExpr)
  }
  const bonus = (name, count) =>
    iff(
      has(name),
      iff(eq(value(name, 2), 0), pct('attack', mul(value(name), count)), mul(value(name), count)),
      0,
    )
  rule(
    'abilityPower',
    'Native power coefficient before resource and contextual effects',
    ['attack', 'ability', 'extraPower', 'user'],
    [
      ['base', add('ability.BasePower', pct('attack', 'ability.BasePAtkRate'), 'extraPower')],
      [
        'scaling',
        add(
          iff(eq('ability.ScalingPower', null), 'ability.BasePower', 'ability.ScalingPower'),
          pct(
            'attack',
            iff(
              eq('ability.ScalingPAtkRate', null),
              'ability.BasePAtkRate',
              'ability.ScalingPAtkRate',
            ),
          ),
          'extraPower',
        ),
      ],
      [
        'attributes',
        add(
          ...core.map((stat) => pct('scaling', pct(`user.Stats.${stat}`, `ability.${stat}Rate`))),
        ),
      ],
    ],
    add('base', 'attributes'),
    calc('CalculateBaseAttack'),
    ['Each core-stat term truncates twice before the terms are added. extraPower is supplied by the contextual modifier stage.'],
  )
  rule(
    'baseDamage',
    'Base ability damage or healing',
    common,
    [
      ['attack', iff('ability.PDefAsPAtk', 'user.Stats.PDef', 'user.Stats.PAtk')],
      [
        'extraPower',
        add(
          bonus('DamagePerTargetDebuff', 'context.targetDebuffCount'),
          bonus('DamagePerSelfBuff', 'context.userBuffCount'),
          bonus('ConsumeComboTokens', statusCount('target', 46)),
        ),
      ],
      ['power', call('abilityPower', 'attack', 'ability', 'extraPower', 'user')],
      ['resources', sum('ability.AbilityMods', 'mod', resourceExpr)],
    ],
    add('power', 'resources'),
    calc('CalculateBaseAttack'),
    [
      'Each of the eight attribute terms truncates twice and is added separately. An absent scaling override inherits the base coefficient; an explicit zero does not. Debuff and buff bonuses count unique statuses; Combo uses the target count.',
    ],
  )
  simple(
    'defenseSeed',
    'Nonlinear defense seed',
    ['stat'],
    sub(500, trunc(div(250000, add(500, trunc(div(mul('stat', 3), 2)))))),
    calc('CalculateDefenseReduction'),
  )
  rule(
    'defense',
    'Damage after defense and penetration',
    ['damage', ...common],
    [
      [
        'physicalDefense',
        iff(
          and(ne('target.Stats.PDefAtFullHPMult', 100), ge('target.HPCurrent', 'target.Stats.HP')),
          pct('target.Stats.PDef', 'target.Stats.PDefAtFullHPMult'),
          'target.Stats.PDef',
        ),
      ],
      [
        'magicalDefense',
        iff(
          and(ne('target.Stats.MDefAtFullHPMult', 100), ge('target.HPCurrent', 'target.Stats.HP')),
          pct('target.Stats.MDef', 'target.Stats.MDefAtFullHPMult'),
          'target.Stats.MDef',
        ),
      ],
      ['physicalDefense', iff(tag('target', 'PDefAsMDef'), 'magicalDefense', 'physicalDefense')],
      ['physicalDefense', pct('physicalDefense', sub(100, min(100, 'user.Stats.PPen')))],
      ['magicalDefense', pct('magicalDefense', sub(100, min(100, 'user.Stats.MPen')))],
      ['redirect', and(gt('damage', 0), tag('user', 'DamageHitsMDef'))],
      ['physicalRate', iff('redirect', 0, 'ability.PDefRate')],
      [
        'magicalRate',
        iff('redirect', add('ability.MDefRate', 'ability.PDefRate'), 'ability.MDefRate'),
      ],
      [
        'baseDefense',
        max(0, add(pct('physicalDefense', 'physicalRate'), pct('magicalDefense', 'magicalRate'))),
      ],
      [
        'attackerMain',
        add(...core.map((stat) => pct(`user.Stats.${stat}`, `ability.${stat}Rate`))),
      ],
      [
        'attackerMain',
        iff(
          eq('attackerMain', 0),
          iff(
            and('ability.IsPAbil', not('ability.IsMAbil')),
            'user.Stats.Str',
            iff(
              and(not('ability.IsPAbil'), 'ability.IsMAbil'),
              'user.Stats.Mnd',
              trunc(div(add(...core.map((stat) => `user.Stats.${stat}`)), 8)),
            ),
          ),
          'attackerMain',
        ),
      ],
      ['physicalMain', iff(tag('target', 'PDefAsMDef'), 'target.Stats.Spi', 'target.Stats.Vit')],
      [
        'targetMain',
        iff(
          and('ability.IsPAbil', not('ability.IsMAbil')),
          'physicalMain',
          iff(
            and(not('ability.IsPAbil'), 'ability.IsMAbil'),
            'target.Stats.Spi',
            iff(
              gt('ability.PDefRate', 'ability.MDefRate'),
              'physicalMain',
              iff(
                lt('ability.PDefRate', 'ability.MDefRate'),
                'target.Stats.Spi',
                trunc(div(add('physicalMain', 'target.Stats.Spi'), 2)),
              ),
            ),
          ),
        ),
      ],
      ['attackerSeed', call('defenseSeed', 'attackerMain')],
      ['targetSeed', call('defenseSeed', 'targetMain')],
      ['seedTotal', add('attackerSeed', 'targetSeed')],
      [
        'strength',
        mul(
          4,
          iff(
            le('seedTotal', 0),
            mul('attackerSeed', 'attackerSeed'),
            trunc(div(mul('attackerSeed', 'attackerSeed'), 'seedTotal')),
          ),
        ),
      ],
      [
        'rate',
        iff(
          le(add('strength', 'baseDefense'), 0),
          100,
          trunc(div(mul(100, 'strength'), add('strength', 'baseDefense'))),
        ),
      ],
    ],
    pct('damage', 'rate'),
    calc('CalculateDefenseReduction'),
    [
      'VIT and SPI enter the defense seed; they are not flat DEF/RES bonuses. Physical-only abilities use target VIT, magical-only use target SPI. Mixed or untyped abilities select by original defense coefficients. DamageHitsMDef redirects defense rates, not this attribute-selection rule.',
    ],
  )
  rule(
    'criticalDamage',
    'Damage on a critical hit',
    ['damage', 'user', 'target', 'ability'],
    [
      [
        'rate',
        iff(
          'ability.IsPAbil',
          pct(
            pct(add('ability.BaseCritDmg', 'user.Stats.PCritDmg'), 'user.Stats.PCritDmgGivenMult'),
            'target.Stats.PCritDmgTakenMult',
          ),
          'ability.BaseCritDmg',
        ),
      ],
      [
        'flat',
        iff(
          'ability.IsPAbil',
          add('user.Stats.PCritDmgGivenFlat', 'target.Stats.PCritDmgTakenFlat'),
          0,
        ),
      ],
      ['extra', add(pct('damage', 'rate'), 'flat')],
      [
        'extra',
        iff(
          gt('target.Stats.CritResist', 0),
          pct('extra', clamp(sub(100, 'target.Stats.CritResist'), 0, 100)),
          'extra',
        ),
      ],
    ],
    add('damage', 'extra'),
    calc('CalculateDamageCrit'),
    [
      'Critical resistance reduces only the extra critical damage, including its flat component. It does not multiply the whole hit.',
    ],
  )
  simple(
    'noncriticalDamage',
    'Damage on a noncritical hit',
    ['damage', 'user', 'target', 'ability'],
    pct(
      'damage',
      iff(
        'ability.IsPAbil',
        pct(pct(100, 'user.Stats.PNonCritDmgGivenMult'), 'target.Stats.PNonCritDmgTakenMult'),
        100,
      ),
    ),
    calc('CalculateDamageNonCrit'),
    ['The given/taken percentages combine with integer truncation before multiplying the hit.'],
  )
  simple(
    'elementPass',
    'One element-multiplier pass',
    ['damage', 'multipliers', 'user', 'ability'],
    add(
      'damage',
      iff(
        eq('ability.Element', null),
        0,
        sub(pct('damage', at('multipliers', 'ability.Element')), 'damage'),
      ),
      iff(
        'ability.IsPAbil',
        sum(
          'user.Stats.PElements',
          'element',
          iff(
            eq('element', 'ability.Element'),
            0,
            sub(pct('damage', at('multipliers', 'element')), 'damage'),
          ),
        ),
        0,
      ),
    ),
    calc('CalculateDamageModification'),
    [
      'Element bonuses within a pass all use the same entering damage and add. The given-element pass runs before the taken-element pass. Do not multiply all element rates together.',
    ],
  )
  rule(
    'repeatMultiplier',
    'Consecutive-use damage multiplier',
    ['multiplier', 'cap', 'repeats'],
    [
      ['rate', max(0, add(100, mul(sub('multiplier', 100), 'repeats')))],
      ['cap', max(0, 'cap')],
    ],
    iff(
      or(eq('multiplier', 100), le('repeats', 0)),
      100,
      iff(
        gt('cap', 100),
        clamp('rate', 100, 'cap'),
        iff(lt('cap', 100), clamp('rate', 'cap', 100), 'rate'),
      ),
    ),
    calc('CalculateDamageModification'),
    ['A cap of exactly 100 does not clamp the computed rate in this executable.'],
  )

  rule(
    'threatDamage',
    'Threat-position damage bonuses',
    ['damage', ...common],
    [
      [
        'forceTop',
        and(
          'context.calcTestMode',
          or(
            gt(value('TopThreatDamageMult'), 0),
            gt(value('NotBottomThreatDamageMult'), 0),
            lt(value('BottomThreatDamageMult'), 0),
            lt(value('NotTopThreatDamageMult'), 0),
          ),
        ),
      ],
      [
        'forceBottom',
        and(
          'context.calcTestMode',
          or(
            lt(value('TopThreatDamageMult'), 0),
            lt(value('NotBottomThreatDamageMult'), 0),
            gt(value('BottomThreatDamageMult'), 0),
            gt(value('NotTopThreatDamageMult'), 0),
          ),
        ),
      ],
      ['bottom', iff(or(has('BottomThreatDamageMult'), has('NotBottomThreatDamageMult'), and('ability.IsPAbil', ne('user.Stats.PDmgWithBottomThreatMult', 100))), or(and('context.bottomThreat', not('forceTop')), 'forceBottom'), false)],
      ['top', iff(or(has('TopThreatDamageMult'), has('NotTopThreatDamageMult')), or(and('context.topThreat', not('forceBottom')), 'forceTop'), false)],
      [
        'bottomBonus',
        iff(
          'bottom',
          iff(
            has('BottomThreatDamageMult'),
            sub(pct('damage', add(100, value('BottomThreatDamageMult'))), 'damage'),
            iff(
              'ability.IsPAbil',
              sub(pct('damage', 'user.Stats.PDmgWithBottomThreatMult'), 'damage'),
              0,
            ),
          ),
          iff(
            has('NotBottomThreatDamageMult'),
            sub(pct('damage', add(100, value('NotBottomThreatDamageMult'))), 'damage'),
            0,
          ),
        ),
      ],
      [
        'topBonus',
        iff(
          'top',
          iff(
            has('TopThreatDamageMult'),
            sub(pct('damage', add(100, value('TopThreatDamageMult'))), 'damage'),
            0,
          ),
          iff(
            has('NotTopThreatDamageMult'),
            sub(pct('damage', add(100, value('NotTopThreatDamageMult'))), 'damage'),
            0,
          ),
        ),
      ],
    ],
    add('damage', 'bottomBonus', 'topBonus'),
    calc('CalculateDamageModification'),
    [
      'Only used for nonhealing member-to-monster actions. All threat bonuses share the entering damage. An ability bottom-threat bonus replaces the passive bottom-threat bonus. calcTestMode is the native preview flag, not an ordinary battle assumption.',
    ],
  )
  const modify = (condition, multiplier, name) => [
    name,
    iff(condition, pct('damage', multiplier), 'damage'),
  ]
  const modSteps = [
    ['healing', call('heals', 'ability')],
    modify('ability.IsBasic', 'user.Stats.BasicAttackMult', 'basic'),
    ['damage', 'basic'],
    [
      'givenElements',
      iff(
        'healing',
        'damage',
        call('elementPass', 'damage', 'user.Stats.ElementDmgGivenMults', 'user', 'ability'),
      ),
    ],
    [
      'takenElements',
      iff(
        'healing',
        'givenElements',
        call(
          'elementPass',
          'givenElements',
          'target.Stats.ElementDmgTakenMults',
          'user',
          'ability',
        ),
      ),
    ],
    ['damage', 'takenElements'],
    modify('healing', 'user.Stats.HealingGivenMult', 'healingGiven'),
    ['damage', 'healingGiven'],
    modify(
      and(
        'healing',
        ne('user.Stats.SelflessCureMult', 100),
        not('context.sameBattler'),
        lt(div('user.HPCurrent', 'user.Stats.HP'), div('target.HPCurrent', 'target.Stats.HP')),
      ),
      'user.Stats.SelflessCureMult',
      'selflessCure',
    ),
    ['damage', 'selflessCure'],
    modify(
      and('healing', ne('user.Stats.CriticalCureMult', 100), le('target.HPCurrent', 'target.HPCriticalValue')),
      'user.Stats.CriticalCureMult',
      'criticalCure',
    ),
    ['damage', 'criticalCure'],
    modify(and(not('healing'), 'ability.IsPAbil'), 'user.Stats.PDmgGivenMult', 'physicalGiven'),
    ['damage', 'physicalGiven'],
    modify(
      and(not('healing'), 'ability.IsPAbil', ne('user.Stats.PDmgGivenWhenCriticalMult', 100), le('user.HPCurrent', 'user.HPCriticalValue')),
      'user.Stats.PDmgGivenWhenCriticalMult',
      'physicalGivenCritical',
    ),
    ['damage', 'physicalGivenCritical'],
    modify(and(not('healing'), 'ability.IsMAbil'), 'user.Stats.MDmgGivenMult', 'magicalGiven'),
    ['damage', 'magicalGiven'],
    modify(
      and('healing', ne('ability.Target', 4), ne('ability.Target', 6)),
      'target.Stats.HealingTakenMult',
      'healingTaken',
    ),
    ['damage', 'healingTaken'],
    modify(and(not('healing'), 'ability.IsPAbil'), 'target.Stats.PDmgTakenMult', 'physicalTaken'),
    ['damage', 'physicalTaken'],
    modify(and(not('healing'), 'ability.IsMAbil'), 'target.Stats.MDmgTakenMult', 'magicalTaken'),
    ['damage', 'magicalTaken'],
    [
      'threat',
      iff(
        and(not('healing'), 'user.IsMember', 'target.IsMonster'),
        call('threatDamage', 'damage', ...common),
        'damage',
      ),
    ],
    ['damage', 'threat'],
    ['abilityBonus', pct('damage', pairValue('user.Stats.AbilityDmgMult', 'ability.ID', 100))],
    ['damage', 'abilityBonus'],
    [
      'statuses',
      fold(
        'ability.AbilityMods',
        'damage',
        iff(
          and(
            eq(
              'item.Tag',
              iff('healing', abilityTag('HealingRateVsStatus'), abilityTag('DamageRateVsStatus')),
            ),
            gt(statusCount('target', 'item.Value1'), 0),
          ),
          pct('acc', add(100, 'item.Value2')),
          'acc',
        ),
      ),
    ],
    ['damage', 'statuses'],
    ['apCost', call('apCost', 'user', 'ability')],
    [
      'apBonus',
      iff(
        and(gt('apCost', 0), tag('user', 'DamageBonusFromAPCost')),
        add('damage', pct('damage', pct('apCost', 'context.config.DamageBonusFromAPCostRate'))),
        'damage',
      ),
    ],
    ['damage', 'apBonus'],
    [
      'multiHealing',
      iff(
        and('healing', eq('ability.Scope', 0), tag('user', 'HealSingleToMulti')),
        add('damage', pct('damage', sub(0, 'context.config.HealMultiWithPenaltyRate'))),
        'damage',
      ),
    ],
    ['damage', 'multiHealing'],
    [
      'singleTarget',
      iff(
        and(ne('ability.Scope', 0), tag('user', 'TargetSingleWithBonus')),
        add('damage', pct('damage', 'context.config.TargetSingleWithBonusRate')),
        'damage',
      ),
    ],
    ['damage', 'singleTarget'],
    modify(
      and(not('healing'), 'ability.IsPAbil', ne('user.Stats.PDmgGivenAgainstSleepMult', 100), gt(statusCount('target', 11), 0)),
      'user.Stats.PDmgGivenAgainstSleepMult',
      'sleep',
    ),
    ['damage', 'sleep'],
    [
      'repeat',
      iff(ne('user.Stats.RepeatActionDmgMult', 100), pct(
        'damage',
        call(
          'repeatMultiplier',
          'user.Stats.RepeatActionDmgMult',
          'user.Stats.RepeatActionDmgMultCap',
          'context.repeatCount',
        ),
      ), 'damage'),
    ],
    ['damage', 'repeat'],
    modify(
      and(not('healing'), ne('target.Stats.DmgTakenWhileChargingMult', 100), 'context.targetCharging'),
      'target.Stats.DmgTakenWhileChargingMult',
      'charging',
    ),
    ['damage', 'charging'],
    [
      'mpImmunity',
      iff(
        and(gt('damage', 0), eq('ability.Attribute', 1), tag('target', 'ImmuneToMPDmg')),
        0,
        'damage',
      ),
    ],
    ['inverted', iff(tag('target', 'InvertDamage'), sub(0, 'mpImmunity'), 'mpImmunity')],
    ['damage', 'inverted'],
    modify(
      and(gt('damage', 0), eq('ability.Attribute', 0), tag('target', 'MPShield')),
      75,
      'shielded',
    ),
    ['mpShieldReduction', sub('shielded', 'damage')],
    ['damage', 'shielded'],
    [
      'targetCap',
      iff(
        eq('target.Stats.MaxDamageTaken', null),
        'damage',
        min('damage', 'target.Stats.MaxDamageTaken'),
      ),
    ],
    [
      'userCap',
      iff(
        eq('user.Stats.MaxDamageGiven', null),
        'targetCap',
        min('targetCap', 'user.Stats.MaxDamageGiven'),
      ),
    ],
    ['abilityCap', iff(has('MaxDamageGiven'), min('userCap', value('MaxDamageGiven')), 'userCap')],
    ['damage', 'abilityCap'],
    [
      'onKill',
      iff(
        and('ability.IsPAbil', ne('user.Stats.PDmgOnKillMult', 100), le('target.HPCurrent', pct('damage', 'user.Stats.PDmgOnKillMult'))),
        pct('damage', 'user.Stats.PDmgOnKillMult'),
        'damage',
      ),
    ],
  ]
  rule(
    'damageModifiers',
    'Ordered damage and healing modifiers',
    ['damage', ...common],
    modSteps,
    'onKill',
    calc('CalculateDamageModification'),
    [
      'The order is part of the formula. Physical and magical modifiers both apply to dual-type attacks. Caps occur before the on-kill multiplier and before random variance. mpShieldReduction is a signed MP change applied separately by AbilityProcessor; preserve it from the evaluation trace.',
    ],
  )
  rule(
    'damage',
    'Complete deterministic damage before randomness',
    [...common, 'isCrit'],
    [
      ['base', call('baseDamage', ...common)],
      ['defended', call('defense', 'base', ...common)],
      [
        'critical',
        iff(
          'isCrit',
          call('criticalDamage', 'defended', 'user', 'target', 'ability'),
          call('noncriticalDamage', 'defended', 'user', 'target', 'ability'),
        ),
      ],
    ],
    call('damageModifiers', 'critical', ...common),
    calc('CalculateDamage'),
    [
      'Resolve hit and crit first. Then pass this signed result to resolvedDamage along with explicit random rolls.',
    ],
  )

  rule(
    'variance',
    'Signed variance amplitude',
    ['damage', 'user', 'ability'],
    [
      ['rate', add('ability.BaseVar', iff('ability.IsPAbil', 'user.Stats.PVariance', 0))],
      [
        'rate',
        iff(
          'ability.IsMAbil',
          pct(add('rate', 'user.Stats.MVariance'), 'user.Stats.MVarianceMult'),
          'rate',
        ),
      ],
    ],
    pct('damage', max(0, 'rate')),
    calc('CalculateVariance'),
  )
  simple(
    'luckFactor',
    'Luck factor for a roll',
    ['userLuck', 'targetLuck', 'activeLuckUp'],
    max(
      0,
      trunc(
        fmul(
          f32(sub(pct('userLuck', add(100, 'activeLuckUp')), trunc(div('targetLuck', 2)))),
          0.75,
        ),
      ),
    ),
    calc('CalculateLuckFactor'),
    [
      'activeLuckUp is the first LuckUp Value1 only while the user turn state is beyond ReadyToExecute and the active ability exists; otherwise pass 0. Steal and escape use the user as both user and target.',
    ],
  )
  simple(
    'luckChance',
    'Chance after consecutive failures',
    ['chance', 'luck', 'failures'],
    add('chance', mul(pct('chance', 'luck'), 'failures')),
    [
      'ResolveHit',
      'ResolveCrit',
      'ResolveStatusApply',
      'ResolveSteal',
      'ResolveEscape',
      'ResolveDamage',
    ].map((name) => `Sang.Battle.RollResolver.${name}`),
    [
      'Do not truncate after multiplying by failures: the percentage increment truncates first. The raw threshold is not clamped; roll a uniform integer from 1 through 100 and succeed when roll <= threshold. A success resets the corresponding failure counter; a failure adds one. Hit, crit, and positive status application have separate counters; steal, escape, and chance damage share the miscellaneous counter.',
    ],
  )
  simple(
    'difficultyHit',
    'Difficulty adjustment to hit chance',
    ['chance', 'modifier'],
    iff(and(ge('chance', 1), le('chance', 99)), clamp(add('chance', 'modifier'), 0, 100), 'chance'),
    'Sang.Battle.RollResolver.ResolveHit',
    [
      'Apply before luck. Select MemberHitChanceMod or MonsterHitChanceMod from the acting battler side and resolved encounter difficulty. Guaranteed 0/100 chances bypass this adjustment.',
    ],
  )
  simple(
    'rollSuccess',
    'Resolve a percent roll',
    ['threshold', 'roll'],
    le('roll', 'threshold'),
    'Sang.Battle.RollResolver.RollDie',
    [
      'The caller supplies a uniform integer roll in [1,100]. This also resolves initial LootChance availability, separately from stealing.',
    ],
  )
  simple(
    'failureCounter',
    'Update a failure counter',
    ['previous', 'success'],
    iff('success', 0, add('previous', 1)),
    'Sang.Battle.RollResolver.ResolveHit',
  )
  rule(
    'varianceRoll',
    'Luck-adjusted variance roll',
    ['luck', 'fullRolls', 'partialRoll'],
    [
      ['best', fold('fullRolls', at('fullRolls', 0), max('acc', 'item'))],
      ['remainder', op('mod', 'luck', 100)],
    ],
    iff(
      and(gt('remainder', 0), gt('partialRoll', 'best')),
      add(pct('best', sub(100, 'remainder')), pct('partialRoll', 'remainder')),
      'best',
    ),
    'Sang.Battle.RollResolver.ResolveVariance',
    [
      'fullRolls contains exactly 1 + trunc(luck/100) independent uniform integers in [0,200]. Draw partialRoll in [0,200] only when luck%100 > 0; otherwise pass 0. The two weighted partial terms truncate separately.',
    ],
  )
  simple(
    'varianceDelta',
    'Variance added to a signed amount',
    ['amplitude', 'roll'],
    pct('amplitude', sub('roll', 100)),
    'Sang.Battle.RollResolver.ResolveVariance',
  )
  rule(
    'resolvedDamage',
    'Post-variance damage and survival guards',
    ['damage', 'varianceDelta', ...common, 'miscRoll', 'luck', 'miscFailures'],
    [
      [
        'varied',
        iff(
          ge('damage', 0),
          max(0, add('damage', 'varianceDelta')),
          min(0, add('damage', 'varianceDelta')),
        ),
      ],
      [
        'chanceMultiplier',
        iff(
          and(
            has('ChanceForDamageMult'),
            call(
              'rollSuccess',
              call('luckChance', value('ChanceForDamageMult'), 'luck', 'miscFailures'),
              'miscRoll',
            ),
          ),
          pct('varied', value('ChanceForDamageMult', 2)),
          'varied',
        ),
      ],
      [
        'resourceCurrent',
        iff(
          eq('ability.Attribute', 0),
          'target.HPCurrent',
          iff(eq('ability.Attribute', 1), 'target.MPCurrent', 'target.APCurrent'),
        ),
      ],
      [
        'noOverflow',
        iff(
          and(
            has('DamageReturnRateNoOverflow_100'),
            op('includes', array(0, 1, 2), 'ability.Attribute'),
          ),
          min('chanceMultiplier', 'resourceCurrent'),
          'chanceMultiplier',
        ),
      ],
      [
        'cannotKill',
        iff(
          and(
            eq('ability.Attribute', 0),
            ge('noOverflow', 'target.HPCurrent'),
            or(
              and('ability.IsPAbil', tag('user', 'PDmgCannotKill')),
              and('ability.IsMAbil', tag('user', 'MDmgCannotKill')),
            ),
          ),
          max(0, sub('target.HPCurrent', 1)),
          'noOverflow',
        ),
      ],
    ],
    iff(
      and(
        tag('target', 'CantBeOneHitKOd'),
        ge('target.HPCurrent', 'target.Stats.HP'),
        ge('cannotKill', 'target.HPCurrent'),
        gt('cannotKill', 1),
      ),
      sub('target.HPCurrent', 1),
      'cannotKill',
    ),
    'Sang.Battle.RollResolver.ResolveDamage',
    [
      'The one-hit-KO guard in this executable has no HP-attribute check. The chance multiplier uses the miscellaneous failure counter only when its tag exists. Apply no-overflow and survival checks after randomness; do not reapply earlier damage caps.',
    ],
  )

  rule(
    'curveSegment',
    'Native single-precision curve interpolation',
    ['position', 'leftX', 'leftY', 'rightX', 'rightY'],
    [
      ['t', fdiv(fsub(f32('position'), f32('leftX')), fsub(f32('rightX'), f32('leftX')))],
      ['t2', fmul('t', 't')],
      ['t3', fmul('t2', 't')],
      ['tangent', fsub(f32('rightY'), f32('leftY'))],
      ['a', fmul(fadd(fsub(fmul(2, 't3'), fmul(3, 't2')), 1), f32('leftY'))],
      ['b', fmul(fadd(fsub('t3', fmul(2, 't2')), 't'), 'tangent')],
      ['c', fmul(fsub(fmul(3, 't2'), fmul(2, 't3')), f32('rightY'))],
      ['d', fmul(fsub('t3', 't2'), 'tangent')],
    ],
    fadd(fadd(fadd('a', 'b'), 'c'), 'd'),
    'Microsoft.Xna.Framework.Curve.GetCurvePosition; ComputeTangents(Linear)',
    [
      'Preserve every f32 operation. Although linear tangents describe a straight segment mathematically, replacing this evaluation with ordinary double-precision linear interpolation changes some truncated results.',
    ],
  )
  const curveTables = {
    hitCurve: [
      [0, 0],
      [0.25, 0.2],
      [0.5, 0.5],
      [0.75, 0.8],
      [0.875, 0.9],
      [1, 0.95],
      [1.25, 0.98],
      [1.5, 1],
    ],
    expLevelCurve: [
      [-10, 0],
      [-5, 0.35],
      [0, 1],
      [5, 1.2],
      [10, 1.2],
    ],
    jpLevelCurve: [
      [-10, 0.8],
      [-5, 0.9],
      [0, 1],
      [5, 1.2],
      [10, 1.4],
    ],
    cumulativeJPCurve: [
      [0, 1.5],
      [200, 1.5],
      [300, 1.4],
      [400, 1.25],
      [600, 1.125],
      [1000, 1],
    ],
    troopRewardCurve: [
      [1, 1],
      [2, 0.95],
      [3, 0.9],
      [4, 0.85],
      [6, 0.8],
      [8, 0.75],
    ],
    defeatLossCapCurve: [
      [1, 0],
      [9, 0],
      [10, 1],
      [11, 2],
      [12, 3],
      [13, 5],
      [14, 7],
      [15, 9],
      [20, 20],
      [25, 50],
      [30, 200],
      [36, 1000],
      [40, 2000],
      [50, 5000],
      [60, 10000],
    ],
  }
  for (const [id, keys] of Object.entries(curveTables)) {
    let expression = f32(keys.at(-1)[1])
    for (let i = keys.length - 1; i > 0; i--)
      expression = iff(
        le(f32('position'), f32(keys[i][0])),
        call('curveSegment', 'position', ...keys[i - 1], ...keys[i]),
        expression,
      )
    simple(
      id,
      id.replace(/([A-Z])/g, ' $1'),
      ['position'],
      iff(lt(f32('position'), f32(keys[0][0])), f32(keys[0][1]), expression),
      'Sang.Battle.CBattle.Initialize',
      ['Outside the table, retain the nearest endpoint value.'],
    )
  }
  simple(
    'physicalHitCurve',
    'Base physical accuracy/evasion curve',
    ['accuracy', 'evasion'],
    iff(gt('evasion', 0), trunc(fmul(call('hitCurve', fdiv(f32('accuracy'), f32('evasion'))), 100)), 100),
    calc('CalculateHitChance'),
    ['Zero evasion yields 100 before ability accuracy, modifiers, difficulty, Luck and miss protection.'],
  )
  rule(
    'ordinaryHitChance',
    'Hit chance without early-exit flags',
    common,
    [
      [
        'physical',
        iff(
          and('ability.IsPAbil', gt('target.Stats.PEvaRating', 0)),
          pct(
            pct(
              add(
                'ability.BaseAcc',
                call('physicalHitCurve', 'user.Stats.PAccRating', 'target.Stats.PEvaRating'),
                'user.Stats.PHitChanceGivenAddi',
                'target.Stats.PHitChanceTakenAddi',
              ),
              'user.Stats.PHitChanceGivenMult',
            ),
            'target.Stats.PHitChanceTakenMult',
          ),
          add('ability.BaseAcc', 100),
        ),
      ],
      [
        'chance',
        iff(
          'ability.IsPAbil',
          'physical',
          iff(
            'ability.IsMAbil',
            add(
              'ability.BaseAcc',
              100,
              'user.Stats.MHitChanceGivenAddi',
              'target.Stats.MHitChanceTakenAddi',
            ),
            add('ability.BaseAcc', 100),
          ),
        ),
      ],
    ],
    iff(
      and(
        tag('user', 'PerfectHit'),
        ge('chance', 'context.config.PerfectHitAtChanceOrHigher'),
        lt('chance', 100),
      ),
      100,
      iff(
        and(
          tag('target', 'PerfectDodge'),
          le('chance', 'context.config.PerfectDodgeAtChanceOrLower'),
          gt('chance', 0),
        ),
        0,
        clamp('chance', 0, 100),
      ),
    ),
    calc('CalculateHitChance'),
    [
      'Physical takes precedence over magical for hybrid abilities. Zero target evasion bypasses physical hit modifiers. PerfectHit is checked before PerfectDodge.',
    ],
  )
  const statusBlocked = or(
    ...[
      ['StatusRequiredTarget', 'target', true],
      ['StatusRequiredUser', 'user', true],
      ['StatusRestrictedTarget', 'target', false],
      ['StatusRestrictedUser', 'user', false],
    ].map(([name, who, required]) =>
      ne(
        find(
          'ability.AbilityMods',
          'mod',
          and(
            eq('mod.Tag', abilityTag(name)),
            required
              ? le(statusCount(who, 'mod.Value1'), 0)
              : gt(statusCount(who, 'mod.Value1'), 0),
          ),
        ),
        null,
      ),
    ),
  )
  const blocked = or(
    and(
      'ability.IsPAbil',
      ne(call('actualScope', 'user', 'ability'), 0),
      tag('target', 'DodgeIndirectPAoe'),
      'user.IsMonster',
      not('context.targetIsThreatTarget'),
    ),
    statusBlocked,
    and(eq('ability.Element', 3), tag('target', 'Float')),
    and(
      'user.IsMember',
      'target.IsMonster',
      has('NotBottomThreatAlwaysMiss'),
      not('context.bottomThreat'),
      not('context.calcTestMode'),
    ),
    and('ability.IsPAbil', or(tag('user', 'PHit_Never'), tag('target', 'PEva_Always'))),
    and('ability.IsMAbil', or(tag('user', 'MHit_Never'), tag('target', 'MEva_Always'))),
  )
  const guaranteed = or(
    has('NeverMiss'),
    and('ability.IsPAbil', or(tag('user', 'PHit_Always'), tag('target', 'PEva_Never'))),
    and('ability.IsMAbil', or(tag('user', 'MHit_Always'), tag('target', 'MEva_Never'))),
  )
  simple(
    'hitChance',
    'Hit chance with flags and status requirements',
    common,
    iff(
      blocked,
      0,
      iff(
        guaranteed,
        100,
        iff(
          has('FixedHitRate_100'),
          value('FixedHitRate_100'),
          call('ordinaryHitChance', ...common),
        ),
      ),
    ),
    calc('CalculateHitChance'),
    [
      'Forced misses precede guaranteed hits, which precede a fixed hit rate. Fixed hit rates return directly without clamping or PerfectHit/PerfectDodge. Next apply difficultyHit and luckChance before rolling.',
    ],
  )
  const canCritFlag = or('ability.IsPAbil', gt('ability.BaseCritChance', 0))
  simple(
    'critChance',
    'Critical-hit chance',
    ['user', 'target', 'ability'],
    iff(
      or(
        tag('target', 'CritImmunity'),
        and(canCritFlag, or(has('NeverCrit'), tag('user', 'CritNever'))),
      ),
      0,
      iff(
        and(canCritFlag, or(has('AlwaysCrit'), tag('user', 'CritAlways'))),
        100,
        clamp(
          iff(
            'ability.IsPAbil',
            pct(
              pct(
                add('ability.BaseCritChance', 'user.Stats.PCritChance'),
                'user.Stats.PCritChanceGivenMult',
              ),
              'target.Stats.PCritChanceTakenMult',
            ),
            'ability.BaseCritChance',
          ),
          0,
          100,
        ),
      ),
    ),
    calc('CalculateCritChance'),
    [
      'Always/Never Crit flags are gated by physical type or a positive ability base critical chance. Apply luckChance before the actual roll.',
    ],
  )

  simple(
    'statusChance',
    'Status chance after immunities',
    ['chance', 'immuneByID', 'immuneByCategory', 'resistsReapplication', 'previouslyApplied'],
    iff(
      or('immuneByID', 'immuneByCategory', and('resistsReapplication', 'previouslyApplied')),
      0,
      'chance',
    ),
    calc('CalculateStatusApplyChance'),
  )
  rule(
    'statusDuration',
    'Status duration or stack count',
    [
      'count',
      'category',
      'permanentBuffs',
      'permanentDebuffs',
      'receivedFlat',
      'appliedFlat',
      'receivedAdditive',
      'appliedAdditive',
    ],
    [
      ['flatCount', add('count', 'receivedFlat', 'appliedFlat')],
      ['modified', add('flatCount', pct('flatCount', add('receivedAdditive', 'appliedAdditive')))],
    ],
    iff(
      or(lt('count', 0), eq('count', 255), not(op('includes', array(1, 2), 'category'))),
      'count',
      iff(
        or(and(eq('category', 1), 'permanentBuffs'), and(eq('category', 2), 'permanentDebuffs')),
        255,
        clamp('modified', 0, 254),
      ),
    ),
    calc('CalculateStatusApplyCount'),
    [
      'Category 1 is buff and 2 debuff. Supply the corresponding target duration and user apply-duration bonuses. Negative removal counts and permanent count 255 pass through. Flat adjustments precede additive percentages.',
    ],
  )
  simple(
    'statusRoll',
    'Status application or removal roll',
    ['count', 'canApply', 'canRemove', 'chance', 'luck', 'failures', 'roll'],
    iff(
      gt('count', 0),
      and(
        'canApply',
        call('rollSuccess', call('luckChance', 'chance', 'luck', 'failures'), 'roll'),
      ),
      iff(lt('count', 0), and('canRemove', call('rollSuccess', 'chance', 'roll')), false),
    ),
    'Sang.Battle.RollResolver.ResolveStatusApply',
    [
      'Pass the immunity-adjusted chance for positive applications. Removal does not use Luck or the failure counter. An ineligible or zero-count attempt returns without changing the counter.',
    ],
  )
  simple(
    'stealChance',
    'Steal chance for one available loot entry',
    ['baseChance', 'stealChanceUp'],
    trunc(div(mul(100, add('baseChance', 'stealChanceUp')), add(100, 'stealChanceUp'))),
    calc('CalculateStealChance'),
    [
      'This is not LootChance, the separate availability roll. A StealChanceUp total of -100 divides by zero and is invalid. Apply Luck against the user and the shared miscellaneous failure counter per attempt.',
    ],
  )
  simple(
    'combinedStealChance',
    'Displayed chance to steal at least one remaining item',
    ['chances'],
    trunc(fold('chances', 0, fadd('acc', fdiv(fmul(fsub(100, 'acc'), f32('item')), 100)))),
    calc('CalculateStealChance'),
    [
      'Pass per-entry steal chances for the remaining available loot entries in their native order. This display calculation is not the sequence of actual rolls.',
    ],
  )
  simple(
    'escapeChance',
    'Base escape chance',
    ['userLevel', 'livingPresentEnemyLevels', 'perfectEscape'],
    iff(
      'perfectEscape',
      100,
      clamp(
        add(
          80,
          mul(
            sub(
              'userLevel',
              trunc(
                div(
                  sum('livingPresentEnemyLevels', 'level', 'level'),
                  sum('livingPresentEnemyLevels', 'level', 1),
                ),
              ),
            ),
            5,
          ),
        ),
        20,
        100,
      ),
    ),
    calc('CalculateEscapeChance'),
    [
      'Supply only alive and present enemies; a non-perfect escape requires at least one. Then apply Luck against the user and the shared miscellaneous failure counter.',
    ],
  )

  const returnMod = sum(
    'ability.AbilityMods',
    'mod',
    iff(
      eq('mod.Value1', 'attribute'),
      iff(
        eq('mod.Tag', abilityTag('DamageReturnRateOverflow_100')),
        pct('overflowDamage', 'mod.Value2'),
        iff(
          eq('mod.Tag', abilityTag('DamageReturnRateNoOverflow_100')),
          pct('actualDamage', 'mod.Value2'),
          iff(
            eq('mod.Tag', abilityTag('DamageReturnRateOnKill_100')),
            pct('killDamage', 'mod.Value2'),
            0,
          ),
        ),
      ),
      0,
    ),
  )
  const resourceReturn = (resource) =>
    add(
      iff(
        'ability.IsPAbil',
        add(
          iff(
            gt('overflowDamage', 0),
            add(
              `user.Stats.PDmg${resource}ReturnFlat`,
              pct('overflowDamage', `user.Stats.PDmg${resource}ReturnAddi`),
            ),
            0,
          ),
          iff(
            gt('killDamage', 0),
            pct('killDamage', `user.Stats.PDmg${resource}ReturnOnKillAddi`),
            0,
          ),
        ),
        0,
      ),
      iff(
        'ability.IsMAbil',
        add(
          iff(
            gt('overflowDamage', 0),
            pct('overflowDamage', `user.Stats.MDmg${resource}ReturnAddi`),
            0,
          ),
          iff(
            gt('killDamage', 0),
            pct('killDamage', `user.Stats.MDmg${resource}ReturnOnKillAddi`),
            0,
          ),
        ),
        0,
      ),
      iff(
        and(call('heals', 'ability'), lt('overflowDamage', 0)),
        pct('overflowDamage', `user.Stats.Healing${resource}ReturnAddi`),
        0,
      ),
    )
  rule(
    'damageReturn',
    'Lifesteal, resource return, and recoil',
    ['actualDamage', 'overflowDamage', 'killDamage', 'user', 'ability', 'attribute'],
    [
      [
        'killMod',
        find(
          'ability.AbilityMods',
          'mod',
          op('includes', array(abilityTag('KillsUser'), abilityTag('KillsUserAlmost')), 'mod.Tag'),
        ),
      ],
      ['abilityReturn', returnMod],
      [
        'statReturn',
        iff(
          eq('attribute', 0),
          resourceReturn('HP'),
          iff(
            eq('attribute', 1),
            resourceReturn('MP'),
            iff(eq('attribute', 2), resourceReturn('AP'), 0),
          ),
        ),
      ],
      [
        'healingReturn',
        iff(
          and(
            eq('ability.Attribute', 'attribute'),
            call('heals', 'ability'),
            lt('overflowDamage', 0),
          ),
          pct('overflowDamage', 'user.Stats.HealingReturnAddi'),
          0,
        ),
      ],
      ['total', add('abilityReturn', 'statReturn', 'healingReturn')],
    ],
    iff(
      and(eq('attribute', 0), ne('killMod', null)),
      iff(
        eq(field('killMod', 'Tag'), abilityTag('KillsUser')),
        'user.Stats.HP',
        max(0, sub('user.HPCurrent', 1)),
      ),
      iff(and(lt('total', 0), tag('user', 'DisableLifestealAndRegen')), 0, 'total'),
    ),
    calc('CalculateDamageReturn'),
    [
      'Return amounts are signed damage to the user: negative restores resources. KillsUser/KillsUserAlmost return immediately for HP and bypass recovery suppression. Supply actual, potential including overflow, and on-kill damage accumulated by AbilityProcessor, not the same number in all three slots.',
    ],
  )

  simple(
    'assistRewardRate',
    'Select an EXP or JP assist multiplier',
    ['lessEnabled', 'lessRate', 'boostEnabled', 'boostRate'],
    iff(
      and('lessEnabled', ne('lessRate', 100)),
      'lessRate',
      iff(and('boostEnabled', ne('boostRate', 100)), 'boostRate', 100),
    ),
    calc('CalculateExpReward'),
    [
      'Use the EXP or JXP flags for the relevant reward. Less takes priority only when enabled with a non-100 rate.',
    ],
  )
  rule(
    'expReward',
    'EXP reward per monster and member',
    [
      'reward',
      'monsterLevel',
      'memberLevel',
      'troopSize',
      'boss',
      'alive',
      'expBoostRate',
      'assistRate',
    ],
    [
      [
        'rate',
        iff(
          'boss',
          1,
          fmul(
            fmul(
              call('expLevelCurve', sub('monsterLevel', min(60, 'memberLevel'))),
              call('troopRewardCurve', 'troopSize'),
            ),
            iff('alive', 1, 0.75),
          ),
        ),
      ],
      [
        'rate',
        iff(ne('expBoostRate', 100), fmul('rate', fmul(f32('expBoostRate'), f32(0.01))), 'rate'),
      ],
      [
        'rate',
        iff(ne('assistRate', 100), fmul('rate', fmul(f32('assistRate'), f32(0.01))), 'rate'),
      ],
    ],
    iff(gt('reward', 0), trunc(fadd(fmul(f32('reward'), 'rate'), 0.25)), 0),
    calc('CalculateExpReward'),
    [
      'Boss EXP bypasses level, troop-size, and death penalties; boosts still apply. The member level is capped at 60 only for the level-difference lookup.',
    ],
  )
  rule(
    'jpReward',
    'JP reward per monster and member',
    [
      'reward',
      'monsterLevel',
      'memberLevel',
      'troopSize',
      'totalJobJP',
      'boss',
      'alive',
      'jobBoostRate',
      'allJobBoostRate',
      'assistRate',
    ],
    [
      [
        'rate',
        fmul(
          fmul(
            call('cumulativeJPCurve', 'totalJobJP'),
            call('jpLevelCurve', sub('monsterLevel', min(60, 'memberLevel'))),
          ),
          call('troopRewardCurve', 'troopSize'),
        ),
      ],
      ['rate', iff('alive', 'rate', fmul('rate', 0.75))],
      ['rate', iff(and('boss', lt('rate', 1)), 1, 'rate')],
      ['rate', fmul('rate', fmul(f32('jobBoostRate'), f32(0.01)))],
      [
        'rate',
        iff(
          ne('allJobBoostRate', 100),
          fmul('rate', fmul(f32('allJobBoostRate'), f32(0.01))),
          'rate',
        ),
      ],
      [
        'rate',
        iff(ne('assistRate', 100), fmul('rate', fmul(f32('assistRate'), f32(0.01))), 'rate'),
      ],
    ],
    iff(gt('reward', 0), trunc(fadd(fmul(f32('reward'), 'rate'), 0.25)), 0),
    calc('CalculateJPReward'),
    [
      'Use total accumulated JP in the current job, not unspent JP. Bosses impose a minimum rate of 1 after ordinary penalties and before boosts. Use the first matching per-job boost; pass 100 if absent.',
    ],
  )
  simple(
    'defeatCurrencyLoss',
    'Currency lost on defeat',
    ['remainingEnemyMoney', 'presentMemberLevels', 'currency', 'lossEnabled'],
    iff(
      'lossEnabled',
      max(
        0,
        min(
          'remainingEnemyMoney',
          trunc(
            call(
              'defeatLossCapCurve',
              iff(
                gt(sum('presentMemberLevels', 'level', 1), 0),
                trunc(
                  div(
                    sum('presentMemberLevels', 'level', 'level'),
                    sum('presentMemberLevels', 'level', 1),
                  ),
                ),
                0,
              ),
            ),
          ),
          trunc(div('currency', 10)),
        ),
      ),
      0,
    ),
    'Sang.Battle.VoxelBattle.CalculateCurrencyLoss',
    [
      'remainingEnemyMoney is the sum from alive, present enemies. The average level includes all present members, alive or dead. The caller supplies the native defeat-loss eligibility flag.',
    ],
  )
  simple(
    'difficultyStat',
    'Enemy attribute or equipment input after difficulty',
    ['base', 'rate'],
    pct('base', 'rate'),
    'Sang.Battle.BattlerMonster.RecalcBaseStats; RecalcEquipStats',
  )
  rule(
    'difficultyVital',
    'Enemy HP or MP after difficulty',
    ['base', 'rate'],
    [['scaled', pct('base', 'rate')]],
    iff(
      eq('rate', 100),
      'base',
      iff(
        lt('scaled', 100),
        mul(trunc(div(add('scaled', 2), 5)), 5),
        mul(trunc(div(add('scaled', 5), 10)), 10),
      ),
    ),
    'Sang.Battle.BattlerMonster.RecalcBaseStats',
    [
      'Choose the boss or ordinary-enemy HP/MP rate from the selected native difficulty. Round only when the rate differs from 100.',
    ],
  )

  simple(
    'applyResource',
    'Resource remaining after signed damage',
    ['current', 'maximum', 'damage', 'locked'],
    iff('locked', 'current', clamp(sub('current', 'damage'), 0, 'maximum')),
    'Sang.Battle.BattlerBase.ApplyDamage',
    [
      'Only MP uses MPLock. Positive amounts remove resources; negative amounts restore them. Death, revival, and reactions are separate state transitions.',
    ],
  )
  simple(
    'actualResourceDamage',
    'Actual damage or recovery reported by application',
    ['current', 'maximum', 'damage'],
    iff(
      gt('damage', 0),
      clamp('damage', 0, 'current'),
      iff(lt('damage', 0), clamp('damage', sub('current', 'maximum'), 0), 'damage'),
    ),
    'Sang.Battle.BattlerBase.ApplyDamage',
    [
      'The native returned amount is bounded independently of MPLock, even when locked MP does not change.',
    ],
  )
  simple(
    'spendResource',
    'Resource remaining after paying a positive cost',
    ['current', 'maximum', 'cost', 'minimum', 'locked'],
    iff(
      and(gt('cost', 0), not('locked')),
      clamp(sub('current', 'cost'), 'minimum', 'maximum'),
      'current',
    ),
    'Sang.Battle.BattlerBase.SpendAbilityCost',
    ['HP costs retain at least 1 HP. MP and AP retain at least 0. Only MP respects MPLock.'],
  )
  simple(
    'accumulateAP',
    'AP after an accumulation event',
    ['current', 'maximum', 'baseGain', 'bonus', 'multiplier'],
    clamp(add('current', pct(add('baseGain', 'bonus'), 'multiplier')), 0, 'maximum'),
    'Sang.Battle.BattlerBase.AccumulateAP',
    [
      'Base gain is 6 on turn, basic attack, or surviving opposing physical damage; 0 on battle start or magic. Ability AccumulateAP modifiers add their Value1 values. Recovery-on-AP uses the actual increase after the capacity clamp.',
    ],
  )
  simple(
    'apHPRecovery',
    'HP recovered from an actual AP gain',
    ['actualGain', 'maximumHP', 'enabled'],
    iff(and('enabled', gt('actualGain', 0)), sub(0, pct('actualGain', 'maximumHP')), 0),
    'Sang.Battle.BattlerBase.RecoverHPForAP',
  )
  simple(
    'apMPRecovery',
    'MP recovered from an actual AP gain',
    ['actualGain', 'enabled'],
    iff(and('enabled', gt('actualGain', 0)), sub(0, 'actualGain'), 0),
    'Sang.Battle.BattlerBase.RecoverMPForAP',
  )
  simple(
    'hpAlert',
    'Low-HP threshold',
    ['maximumHP'],
    trunc(div('maximumHP', 2)),
    'Sang.Battle.BattlerBase.RecalcStats',
  )
  simple(
    'hpCritical',
    'Critical-HP threshold',
    ['maximumHP'],
    trunc(div('maximumHP', 4)),
    'Sang.Battle.BattlerBase.RecalcStats',
  )
  simple(
    'absorbedHP',
    'Maximum HP gained by eligible physical damage',
    ['previous', 'damage', 'rate', 'eligible'],
    iff(and('eligible', gt('damage', 0)), add('previous', pct('damage', 'rate')), 'previous'),
    'Sang.Battle.AbilityProcessor.ResolveMaxHPAbsorb',
    [
      'Pass PDmgIncreasesMaxHPAbsorbRate from battleConfig. Add absorbed HP after ordinary HP multipliers and before the member cap.',
    ],
  )
  simple(
    'absorbedHPDecay',
    'Remaining absorbed maximum HP',
    ['previous', 'rate', 'stillEnabled'],
    iff('stillEnabled', max(0, sub('previous', pct('previous', 'rate'))), 0),
    'Sang.Battle.AbilityProcessor.ResolveMaxHPAbsorbDecay',
  )
  simple(
    'convertResourceGain',
    'Resource gained by conversion',
    ['sourceCurrent', 'targetMissing', 'rate'],
    min(pct('sourceCurrent', 'rate'), 'targetMissing'),
    'Sang.Battle.AbilityProcessor.ResolveAbilityMod',
    [
      'MP to HP rate is 1000. MP to AP and AP to MP rate is 100. Application still obeys resource clamps and MPLock.',
    ],
  )
  simple(
    'convertResourceCost',
    'Resource consumed by conversion',
    ['sourceCurrent', 'targetMissing', 'rate'],
    iff(
      le(pct('sourceCurrent', 'rate'), 'targetMissing'),
      'sourceCurrent',
      trunc(div(mul('targetMissing', 100), 'rate')),
    ),
    'Sang.Battle.AbilityProcessor.ResolveAbilityMod',
  )
  simple(
    'secondaryAttributeDamage',
    'Additional HP, MP, or AP damage',
    ['potentialDamage', 'rates'],
    pct('potentialDamage', sum('rates', 'rate', 'rate')),
    'Sang.Battle.AbilityProcessor.ResolveDamage',
    [
      'Sum AttributeDamageRate Value2 for the desired resource, excluding modifiers whose resource equals the primary ability Attribute. Use potential damage, not actual capped damage.',
    ],
  )
  simple(
    'statusApplicationDamage',
    'Direct damage or healing when a status applies',
    ['maximum', 'value', 'percentage'],
    iff('percentage', pct('maximum', 'value'), 'value'),
    'Sang.Battle.BattlerBase.ApplyStatus',
    [
      'DamageRateOnApply uses the selected maximum directly. DamageOnApply uses the flat value. Neither runs through ordinary attack or periodic modifiers.',
    ],
  )
  simple(
    'stanceRecovery',
    'Resource change on a stance change',
    ['maximum', 'rate'],
    pct('maximum', sub(0, 'rate')),
    'Sang.Battle.AbilityProcessor.ResolveStatusApplication',
  )

  simple(
    'threatGain',
    'Threat after gain modifiers',
    ['amount', 'userMultiplier', 'abilityAdditive', 'hasAbilityModifier'],
    iff(
      or(ne('userMultiplier', 100), 'hasAbilityModifier'),
      max(0, pct(pct('amount', 'userMultiplier'), add(100, 'abilityAdditive'))),
      'amount',
    ),
    'Sang.Battle.AbilityProcessor.ResolveThreatGainRate',
  )
  simple(
    'threatStatBonus',
    'Attribute scaling for flat ability threat',
    ['amount', 'user', 'ability'],
    add('amount', ...core.map((stat) => pct(`user.Stats.${stat}`, `ability.${stat}Rate`))),
    'Sang.Battle.AbilityProcessor.ResolveThreatStatBonus',
  )
  simple(
    'threatCurrentChange',
    'Requested change to existing threat',
    ['current', 'additiveRate', 'flat'],
    add(pct('current', 'additiveRate'), 'flat'),
    'Sang.Battle.AbilityProcessor.ResolveCurrentThreatChange',
  )
  simple(
    'threatDecay',
    'Threat after decay',
    ['current', 'decayMultiplier'],
    pct('current', sub(100, clamp(pct(20, 'decayMultiplier'), 0, 100))),
    'Sang.Battle.ThreatCollection.Decay',
  )
  simple(
    'threatMissingHP',
    'Threat generated from missing HP',
    ['currentHP', 'maximumHP'],
    iff(
      le('currentHP', trunc(div('maximumHP', 2))),
      trunc(div(sub('maximumHP', 'currentHP'), 2)),
      0,
    ),
    'Sang.Battle.ThreatCollection.GenerateFromMissingHP',
  )
  simple(
    'threatHealing',
    'Threat generated by healing a threatened ally',
    ['healing', 'targetMaximumHP', 'targetThreat'],
    trunc(fmul(f32('targetThreat'), clamp(fdiv(f32('healing'), f32('targetMaximumHP')), 0, 1))),
    'Sang.Battle.ThreatCollection.GenerateFromHealing',
    [
      'Use the positive magnitude after threat-gain modifiers. Only alive, present monsters whose highest-threat target is the healed ally receive this threat.',
    ],
  )
  simple(
    'threatApply',
    'Threat after accumulated changes',
    ['current', 'deltas'],
    max(0, add('current', sum('deltas', 'delta', 'delta'))),
    'Sang.Battle.ThreatCollection.ApplyGeneratedThreatDelta',
    [
      'Accumulate all deltas before clamping. Damage threat contributes the threat-gain-adjusted positive HP damage.',
    ],
  )

  const sheetCoverage = {
    CalculateMemberHP: 'memberHP',
    CalculateMemberMP: 'memberMP',
    CalculateMemberStat: 'memberCore',
    CalculateUnarmedPAtkBonus: 'unarmedAttack',
    CalculateTwoHandedPAtkBonus: 'twoHandedAttack',
    CalculatePCritChanceBonus: 'critChance',
    CalculatePCritDmgBonus: 'critDamage',
    CalculatePCritDmgBonus_Formula: 'critDamage',
    CalculatePPenBonus: 'penetration',
    CalculateMPenBonus: 'penetration',
    CalculateTTBonus: 'turnTime',
  }
  simple(
    'defenseStatBonus',
    'Attribute-derived flat DEF or RES bonus',
    ['stat'],
    0,
    [calc('CalculatePDefBonus'), calc('CalculateMDefBonus')],
    ['The native flat bonuses are zero. Vitality and Spirit instead affect defense reduction.'],
  )
  simple('agilityRatingBonus', 'Attribute-derived accuracy or evasion', ['agility'], 'agility', [
    calc('CalculatePAccRatingBonus'),
    calc('CalculatePEvaRatingBonus'),
  ])
  const integerIn = (x, lo, hi) => and(eq(x, trunc(x)), ge(x, lo), le(x, hi))
  formulas.rollSuccess.requirements = [
    {
      condition: integerIn('roll', 1, 100),
      message: 'Percent roll must be an integer from 1 through 100',
    },
  ]
  formulas.varianceRoll.requirements = [
    {
      condition: integerIn('luck', 0, 2147483647),
      message: 'Luck factor must be a nonnegative signed integer',
    },
    {
      condition: eq(op('length', 'fullRolls'), add(1, trunc(div('luck', 100)))),
      message: 'Incorrect number of full variance rolls for the supplied Luck',
    },
    {
      condition: eq(sum('fullRolls', 'roll', iff(integerIn('roll', 0, 200), 0, 1)), 0),
      message: 'Variance rolls must be integers from 0 through 200',
    },
    {
      condition: integerIn('partialRoll', 0, 200),
      message:
        'Partial variance roll must be an integer from 0 through 200; use 0 when no partial roll is drawn',
    },
  ]
  formulas.resourceTerm.requirements = [
    {
      condition: integerIn('mode', 0, 2),
      message: 'Resource mode must be 0 current, 1 missing, or 2 maximum',
    },
  ]
  return {
    schemaVersion: 1,
    id: 'pc-1.6.9-combat-v1',
    source: {
      gameVersion: '1.6.9.0',
      platform: 'Windows PC',
      executableSha256: native.source.executable.sha256,
      files: {
        'Sang/Window/Field/Learn/WindowLearnAbilitySelect.cs': '8f8bbe8e781f4483a4d168c62c97fa129ffd563100b9bee2c53ee26a36a47abf',
        'Sang/Battle/Calculator.cs':
          'eec96d64039169f594aea6158be3b25f740c47d19fb7bcf856451c814c8df5c6',
        'Sang/Battle/RollResolver.cs':
          'c7fd92270453b279fead1e404221091ad33549a6f47b9bd4a44adb0ce0c4004b',
        'Sang/Battle/AbilityProcessor.cs':
          'ab222f7788f5d5b0f8e27054c05c093195712d48c773ec592877a2102add0aec',
        'Sang/Battle/BattlerBase.cs':
          '327d5d6c8676f92bf6aa6b18d85e0df98e34e0c1562bdc61e4d077dbfb310ef8',
        'Sang/Battle/BattlerMonster.cs':
          '212a5980b93e409ce67f6c9770dcd287294cf0d2020b3d796d7f622c416f8ba9',
        'Sang/Battle/ThreatCollection.cs':
          '5c0964aea2bc3b7c94b17420b0259d0147fb2a9721520f75beb8f8f0bf449043',
        'Sang/Battle/HTurn.cs': 'b68e8ed9af48295eb4da27861e7902234bee70fc9f54561a7d5b9c967e04e157',
        'Sang/Battle/CBattle.cs':
          '3cb4fb5614a8e9b61a43b0508a96a32abc527bdb71a92cd15de971593a4cc225',
        'Sang/Battle/VoxelBattle.cs':
          '59fc288dbc8a92f7ad9154032a7350bb0b180fab8ab13930ec44ec8624ab0e10',
        'Sang/SangData/HAbility.cs':
          'ae0eddc80a88cab3031629f6b2a14ae133e3606d12a0648adae03f57654db3ee',
      },
    },
    limits: { depth: 128, nodes: 250000, collection: 10000 },
    semantics: {
      arithmetic:
        'Finite IEEE-754 binary64 unless f32 is explicit. trunc is toward zero. Preserve operation order and intermediate truncations. Native signed-integer overflow is outside the supported input range.',
      inputs:
        'Required, explicit effective stats and battle state. No omitted field is assumed to be zero. Native enum values remain numeric. Null means an absent native nullable field, not an unknown input.',
      scope:
        'Numerical character and combat rules, not a battle scheduler, AI, targeting engine, random generator, or save interpreter. Runtime mods and other platforms require their own verified rules.',
      trust:
        'Only bundled rules are evaluated. Imported descriptions and formula packages are never executed.',
    },
    operators: {
      literals:
        'Number, boolean or null literals; a bare string is a dot-separated own-property variable path, never executable code',
      arithmetic:
        'add and mul fold left to right; sub/div/mod/pow are binary; min/max accept two or more arguments; division by zero and nonfinite results fail',
      integer:
        'trunc rounds toward zero; floor/ceil/abs have their mathematical meanings; i32 requires an integer in [-2147483648,2147483647], rejecting unsupported native overflow',
      f32: 'Round to IEEE-754 binary32, ties to even, retaining its exact value as a number; fail on nonfinite output',
      logic:
        'eq/ne compare values; lt/lte/gt/gte compare numbers; not negates numeric/boolean truth; if(condition,yes,no), and, and or evaluate lazily',
      call: 'call(name,...arguments) evaluates a named formula with positional inputs, requirements, sequential reassignable steps, and result in a fresh local scope',
      collections:
        'array(...expressions) constructs a list; length(list), at(list,integerIndex), and includes(list,value) do not coerce types; invalid indices fail',
      field:
        'field(record,name,fallback) reads an own property; fallback is evaluated only when record is null, not when a property is missing',
      find: 'find(list,itemName,predicate) returns the first matching record or null in a lexical item scope',
      sum: 'sum(list,itemName,expression) adds numeric per-item results in source order starting at 0',
      fold: 'fold(list,itemName,accumulatorName,indexName,initial,expression) visits items in order with zero-based index and lexical accumulator; an empty list returns initial',
    },
    contracts: {
      user: 'Effective battler: Stats has native BattlerStats fields, Tags is an array of native stat-tag numbers, and per-ability lists contain {ID, Value}. HPCurrent/MPCurrent/APCurrent are present resources. HPCriticalValue is trunc(Stats.HP/4). IsMember/IsMonster are booleans. Statuses is [{ID, Count}], with unique native IDs.',
      target:
        'The same battler structure as user, independently supplied. Do not infer target Spirit, defense, HP, or statuses from the attacker.',
      ability:
        'The native numeric ability record from data.records.ability. Preserve explicit zero vs null scaling overrides. AbilityMods remain in source order with numeric Tag, Value1, and Value2.',
      context:
        'Explicit config (battleConfig), sameBattler, calcTestMode, bottomThreat, topThreat, targetIsThreatTarget, targetCharging, repeatCount, targetDebuffCount, and userBuffCount. Unique buff/debuff counts, threat relationships, and recurrence come from live state, not guessed from stats. targetCharging means Turn.State == ReadyToExecute.',
      randomness:
        'Random draws are supplied explicitly. Percent dice are integers 1..100; variance draws are integers 0..200. Luck failure counters and draw counts must be supplied for each attempt in native order.',
    },
    coverage: {
      calculator: {
        ...Object.fromEntries(
          Object.entries(sheetCoverage).map(([method, formula]) => [
            method,
            { module: 'rules', formula },
          ]),
        ),
        ...Object.fromEntries(
          Object.entries(formulas).flatMap(([formula, definition]) =>
            definition.evidence
              .filter((source) => source.startsWith('Sang.Battle.Calculator.'))
              .map((source) => [source.split('.').at(-1), { module: 'combat', formula }]),
          ),
        ),
      },
      stateOwnedByCaller: [
        'Resolved stats and source-group aggregation',
        'Target eligibility, cover, reflection, and action/reaction scheduling',
        'Status eligibility, category counts, reapplication history, removal and timing',
        'Enemy presence, party state, threat positions and target selection',
        'Random generator state, draw order, and failure-counter persistence',
        'Game mode, difficulty, progression history, and runtime mod resolution',
      ],
    },
    curveTables,
    formulas,
  }
}
