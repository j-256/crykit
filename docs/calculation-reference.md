# Human-readable calculation reference

This is the readable equivalent of the bundled PC 1.6.9.0 calculation package, generated from the same formula definitions. Its native game data and calculation code match across the compared Windows and macOS builds; see [verified platform coverage](platform-coverage.md). It does not establish Switch or modded-game parity. Detailed source evidence and verification fixtures remain in the machine-readable package. See [package format and source policy](calculations.md) for installation-free export, compatibility, and input requirements.

## Reading the equations

`trunc(x)` discards the fractional part toward zero: trunc(3.9) = 3, trunc(-3.9) = -3. `roundEven(x)` rounds to the nearest integer, with exact halfway ties going to the even integer. Percentages use 100 for 100%. Keep every displayed rounding step; rounding once at the end is not equivalent. Ordinary integer steps require signed 32-bit results; unsupported overflow is an error, not a guessed wrapped value.

Positive damage removes a resource; negative damage restores it. `user` means the actor; `target` is the recipient. Their `Stats` fields are effective values after the game's stat-recalculation pipeline. Native names such as PAtk/PDef/MDef correspond to ATK/DEF/RES. Lck is Luck. A value of `none` means an absent optional native coefficient, not an unknown observation. Missing required inputs stay unresolved.

`f32(x)` rounds to single precision. Hit and reward curves use the game's single-precision interpolation, whose rounding can differ from a simplified straight-line calculation. The exact equations remain below for reproducibility. Named functions link to formula sections through the index. Lists preserve source order; `sum` starts at zero, `first` selects the first matching record, and `fold` passes each result to the next item. The machine evaluator also exposes a step trace.

## What the visible stats do

| Stat | Effect |
| --- | --- |
| HP, MP, maximum AP | Resource capacities. Current AP and maximum AP are different inputs. Percentage costs and periodic effects use the relevant maximum. |
| Strength | Scales abilities with a Strength coefficient and supplies physical penetration. Physical-only defense calculations fall back to Strength when all weighted attacker attributes sum to zero. |
| Vitality | Supplies the defender attribute for physical-only damage reduction and subtracts a percentage-rate-based amount from HP DoT after its multipliers. It does not add flat DEF. |
| Dexterity | Adds physical critical chance and extra critical damage. The CritFromMndAndSpi effect replaces Dexterity with MND + SPI, not their average. |
| Agility | Adds to both physical accuracy and evasion ratings; their ratio feeds the hit curve. |
| Mind | Scales abilities with a Mind coefficient and supplies magical penetration. Magical-only defense calculations fall back to Mind when the weighted attacker sum is zero. |
| Spirit | Scales abilities with a Spirit coefficient, supplies the defender attribute for magical-only damage reduction, and increases percentage HP regeneration received. It does not add flat RES. |
| Speed | Reduces ordinary turn time through the speed curve. Charge time and free/instant turns have separate rules. |
| Luck | Improves hit, crit, and positive status-application thresholds after consecutive failures, and biases variance upward. Steal, escape, and chance-damage rolls use the shared miscellaneous failure counter. |
| ATK | Enters an ability's base and scaling power through its attack coefficients. PDefAsPAtk substitutes DEF. It is not a universal multiplier for every ability. |
| DEF / RES | Enter the defense reduction formula according to the ability's physical/magical defense coefficients, after full-HP effects and penetration. |
| Physical / magical penetration | Reduce the corresponding defense input. Damage calculation caps each penetration at 100%. |
| Critical chance / extra critical damage | Physical crit chance and bonus damage before ability coefficients and battle modifiers. Critical resistance reduces only the extra critical damage. |
| Physical accuracy / evasion | Inputs to the physical hit curve, before ability accuracy, hit modifiers, flags, difficulty, and Luck. |
| Variance | Determines the signed random spread after damage modifiers. Luck changes how the variance roll is selected. |

Any attribute can scale an ability when that ability's coefficient says so. Physical/magical classification controls other stages independently; it does not force every physical attack to use only Strength or every spell to use only Mind.

## Damage in plain language

1. Build the ability's base power and scaling power from its coefficients and the actor's ATK (or DEF for PDefAsPAtk). Add applicable buff/debuff/Combo power bonuses.
2. Add each weighted attribute contribution, truncating each nested division separately, then add percentage-resource contributions.
3. Calculate defense from the recipient's DEF/RES and VIT/SPI, the ability coefficients, and the actor's weighted attributes and penetration.
4. Apply the critical bonus or noncritical multipliers.
5. Apply the ordered damage/healing modifiers below. Element bonuses within each element pass add from the same entering amount. Other stages generally use the previous stage's result.
6. Add Luck-adjusted variance, resolve chance multipliers, and apply no-overflow and survival guards. Apply the signed result to the selected resource. Damage returns, secondary-resource damage, and the signed MP-shield adjustment are separate applications.

The complete deterministic path is `damage`. Random resolution is `resolvedDamage`. These take explicit battle context; neither guesses targets, statuses, random draws, or effective stats. The existing character-sheet benchmarks remain isolated examples, not encounter predictions.

## DoT and regeneration in plain language

For HP, first calculate `trunc(max HP * combined rate / 100) + combined flat amount`. A positive subtotal receives percentage-damage and DoT multipliers in order, truncating after each. A negative subtotal receives the periodic-healing multiplier. Then subtract `trunc(VIT * rate / 100)` for a positive rate, or add `trunc(SPI * rate / 100)` for a negative rate. Positive-rate DoT cannot turn into healing. DisableLifestealAndRegen then suppresses negative results.

With 1,000 max HP, a +15% rate, 100 VIT, and no other modifiers, each tick deals 150 - 15 = 135 HP damage. With a -15% rate and 100 SPI, it restores 150 + 15 = 165 HP. Flat-only effects get no VIT/SPI adjustment from this rule. MP/AP periodic changes use their own maximum and flat/rate totals without the HP multipliers or VIT/SPI adjustment.

## Boundaries

The package covers the native Calculator methods, the preserved character-sheet formulas, and the numerical cost, periodic, resource, randomness, threat, difficulty, and reward consumers documented below. Caller-owned state includes resolving stat-source groups, targeting/cover/reflection, eligibility and status timing, action/reaction scheduling, random-state persistence, and runtime mod resolution. This is an arithmetic reference, not a complete game simulator. Formula coverage and parity evidence are exported as machine-readable data.

The arithmetic engine evaluates only bundled rules. Importing a description or formula package does not execute it. Native IDs and selected Standard/Vanilla/Chaos patches are explicit; unavailable facts remain unknown.

## Formula index

### Character-sheet equations

- [Base HP](#sheet-memberhp)
- [Base attribute](#sheet-membercore)
- [Base MP](#sheet-membermp)
- [addPercent](#sheet-addpercent)
- [multiplyPercent](#sheet-multiplypercent)
- [perLevel](#sheet-perlevel)
- [perTurn](#sheet-perturn)
- [Attribute-derived critical chance](#sheet-critchance)
- [Attribute-derived extra critical damage](#sheet-critdamage)
- [Attribute-derived penetration](#sheet-penetration)
- [Speed-derived turn time](#sheet-turntime)
- [Unarmed attack bonus](#sheet-unarmedattack)
- [Two-Handed attack bonus](#sheet-twohandedattack)
- [Defense seed](#sheet-defenseseed)
- [Benchmark defense multiplier](#sheet-defenserate)
- [Isolated damage benchmark](#sheet-benchmarkdamage)

### Combat equations

- [LP cost displayed in the native learn tree](#combat-learninglp)
- [Whole LP sufficient for a JP cost](#combat-learningwholelp)
- [JP affordability before learning prerequisites](#combat-learningeligible)
- [Apply a percentage, truncating toward zero](#combat-percent)
- [Maximum resource used by periodic effects](#combat-effectivemaximum)
- [Vitality and Spirit adjustment to periodic HP](#combat-dotresistance)
- [HP damage or regeneration per tick](#combat-periodichp)
- [MP or AP periodic change](#combat-periodicresource)
- [Classify an ability as healing](#combat-heals)
- [Effective single or multi-target scope](#combat-actualscope)
- [HP cost](#combat-hpcost)
- [MP cost](#combat-mpcost)
- [AP cost](#combat-apcost)
- [Charge time](#combat-chargetime)
- [Cooldown after an ability](#combat-cooldown)
- [Item consumption](#combat-itemconsumption)
- [Time until the next turn](#combat-nextturn)
- [Percentage-resource contribution to base damage](#combat-resourceterm)
- [Native power coefficient before resource and contextual effects](#combat-abilitypower)
- [Base ability damage or healing](#combat-basedamage)
- [Nonlinear defense seed](#combat-defenseseed)
- [Damage after defense and penetration](#combat-defense)
- [Damage on a critical hit](#combat-criticaldamage)
- [Damage on a noncritical hit](#combat-noncriticaldamage)
- [One element-multiplier pass](#combat-elementpass)
- [Consecutive-use damage multiplier](#combat-repeatmultiplier)
- [Threat-position damage bonuses](#combat-threatdamage)
- [Ordered damage and healing modifiers](#combat-damagemodifiers)
- [Complete deterministic damage before randomness](#combat-damage)
- [Signed variance amplitude](#combat-variance)
- [Luck factor for a roll](#combat-luckfactor)
- [Chance after consecutive failures](#combat-luckchance)
- [Difficulty adjustment to hit chance](#combat-difficultyhit)
- [Resolve a percent roll](#combat-rollsuccess)
- [Update a failure counter](#combat-failurecounter)
- [Luck-adjusted variance roll](#combat-varianceroll)
- [Variance added to a signed amount](#combat-variancedelta)
- [Post-variance damage and survival guards](#combat-resolveddamage)
- [Native single-precision curve interpolation](#combat-curvesegment)
- [hit Curve](#combat-hitcurve)
- [exp Level Curve](#combat-explevelcurve)
- [jp Level Curve](#combat-jplevelcurve)
- [cumulative J P Curve](#combat-cumulativejpcurve)
- [troop Reward Curve](#combat-trooprewardcurve)
- [defeat Loss Cap Curve](#combat-defeatlosscapcurve)
- [Base physical accuracy/evasion curve](#combat-physicalhitcurve)
- [Hit chance without early-exit flags](#combat-ordinaryhitchance)
- [Hit chance with flags and status requirements](#combat-hitchance)
- [Critical-hit chance](#combat-critchance)
- [Status chance after immunities](#combat-statuschance)
- [Status duration or stack count](#combat-statusduration)
- [Status application or removal roll](#combat-statusroll)
- [Steal chance for one available loot entry](#combat-stealchance)
- [Displayed chance to steal at least one remaining item](#combat-combinedstealchance)
- [Base escape chance](#combat-escapechance)
- [Lifesteal, resource return, and recoil](#combat-damagereturn)
- [Select an EXP or JP assist multiplier](#combat-assistrewardrate)
- [EXP reward per monster and member](#combat-expreward)
- [JP reward per monster and member](#combat-jpreward)
- [Currency lost on defeat](#combat-defeatcurrencyloss)
- [Enemy attribute or equipment input after difficulty](#combat-difficultystat)
- [Enemy HP or MP after difficulty](#combat-difficultyvital)
- [Resource remaining after signed damage](#combat-applyresource)
- [Actual damage or recovery reported by application](#combat-actualresourcedamage)
- [Resource remaining after paying a positive cost](#combat-spendresource)
- [AP after an accumulation event](#combat-accumulateap)
- [HP recovered from an actual AP gain](#combat-aphprecovery)
- [MP recovered from an actual AP gain](#combat-apmprecovery)
- [Low-HP threshold](#combat-hpalert)
- [Critical-HP threshold](#combat-hpcritical)
- [Maximum HP gained by eligible physical damage](#combat-absorbedhp)
- [Remaining absorbed maximum HP](#combat-absorbedhpdecay)
- [Resource gained by conversion](#combat-convertresourcegain)
- [Resource consumed by conversion](#combat-convertresourcecost)
- [Additional HP, MP, or AP damage](#combat-secondaryattributedamage)
- [Direct damage or healing when a status applies](#combat-statusapplicationdamage)
- [Resource change on a stance change](#combat-stancerecovery)
- [Threat after gain modifiers](#combat-threatgain)
- [Attribute scaling for flat ability threat](#combat-threatstatbonus)
- [Requested change to existing threat](#combat-threatcurrentchange)
- [Threat after decay](#combat-threatdecay)
- [Threat generated from missing HP](#combat-threatmissinghp)
- [Threat generated by healing a threatened ally](#combat-threathealing)
- [Threat after accumulated changes](#combat-threatapply)
- [Attribute-derived flat DEF or RES bonus](#combat-defensestatbonus)
- [Attribute-derived accuracy or evasion](#combat-agilityratingbonus)

## Input contracts

### user

Effective battler: Stats has native BattlerStats fields, Tags is an array of native stat-tag numbers, and per-ability lists contain {ID, Value}. HPCurrent/MPCurrent/APCurrent are present resources. HPCriticalValue is trunc(Stats.HP/4). IsMember/IsMonster are booleans. Statuses is [{ID, Count}], with unique native IDs.

### target

The same battler structure as user, independently supplied. Do not infer target Spirit, defense, HP, or statuses from the attacker.

### ability

The native numeric ability record from data.records.ability. Preserve explicit zero vs null scaling overrides. AbilityMods remain in source order with numeric Tag, Value1, and Value2.

### context

Explicit config (battleConfig), sameBattler, calcTestMode, bottomThreat, topThreat, targetIsThreatTarget, targetCharging, repeatCount, targetDebuffCount, and userBuffCount. Unique buff/debuff counts, threat relationships, and recurrence come from live state, not guessed from stats. targetCharging means Turn.State == ReadyToExecute.

### randomness

Random draws are supplied explicitly. Percent dice are integers 1..100; variance draws are integers 0..200. Luck failure counters and draw counts must be supplied for each attempt in native order.

The exported `example` is an explicitly synthetic complete input fixture. It has 1003 maximum HP, 131 Strength, and 163 ATK; it is not a real character or recommendation.

## Character-sheet equations

<a id="sheet-memberhp"></a>

### Base HP

Formula ID: `memberHP`. Inputs, in order: `level`, `rating`, `growth`, `boost`.

```text
seed = trunc((((rating * level) + growth) / 2))
base = ((50 + rating) + if boost then 10 else 0)
gain = (((level * 9.533) + ((seed * 11.3) / 100)) + if boost then (level * 1.5) else 0)
result = roundEven((base + gain))
```

<a id="sheet-membercore"></a>

### Base attribute

Formula ID: `memberCore`. Inputs, in order: `level`, `rating`, `growth`, `boost`.

```text
seed = trunc((((rating * level) + growth) / 2))
base = ((5 + ((rating * 10) / 100)) + if boost then 3 else 0)
gain = (((level * 1.25) + ((seed * 2.75) / 100)) + if boost then (level * 0.2) else 0)
result = roundEven((base + gain))
```

<a id="sheet-membermp"></a>

### Base MP

Formula ID: `memberMP`. Inputs, in order: `level`, `rating`, `growth`, `boost`.

```text
seed = trunc((((rating * level * 3) + (growth * 2)) / 5))
base = ((6 + ((rating * 24) / 100)) + if boost then 6 else 0)
gain = (((level * 0.25) + ((seed * 3.55) / 100)) + if boost then (level * 0.233) else 0)
result = roundEven((base + gain))
```

<a id="sheet-addpercent"></a>

### addPercent

Formula ID: `addPercent`. Inputs, in order: `base`, `percent`.

```text
result = (base + trunc(((base * percent) / 100)))
```

<a id="sheet-multiplypercent"></a>

### multiplyPercent

Formula ID: `multiplyPercent`. Inputs, in order: `base`, `percent`.

```text
result = trunc(((base * percent) / 100))
```

<a id="sheet-perlevel"></a>

### perLevel

Formula ID: `perLevel`. Inputs, in order: `value`, `level`, `denominator`.

```text
result = trunc(((value * level) / denominator))
```

<a id="sheet-perturn"></a>

### perTurn

Formula ID: `perTurn`. Inputs, in order: `value`, `turn`, `limit`.

```text
result = (value * min(turn, limit))
```

<a id="sheet-critchance"></a>

### Attribute-derived critical chance

Formula ID: `critChance`. Inputs, in order: `seed`.

```text
x = max(0, seed)
result = trunc((75 * (x / (x + 150))))
```

<a id="sheet-critdamage"></a>

### Attribute-derived extra critical damage

Formula ID: `critDamage`. Inputs, in order: `seed`.

```text
atCap = (25 + ((300 / 15) ^ 1.35))
slope = (atCap - (25 + ((299 / 15) ^ 1.35)))
result = trunc(if (seed <= 300) then (25 + ((seed / 15) ^ 1.35)) else (atCap + ((seed - 300) * slope)))
```

<a id="sheet-penetration"></a>

### Attribute-derived penetration

Formula ID: `penetration`. Inputs, in order: `seed`.

```text
x = max(0, seed)
result = trunc(((100 * x) / (x + 300)))
```

<a id="sheet-turntime"></a>

### Speed-derived turn time

Formula ID: `turnTime`. Inputs, in order: `speed`, `multiplier`.

```text
speed = max(0, min(600, speed))
tt = (((34 + ((0.0175 * (speed - 600)) ^ 2)) * multiplier) / 100)
result = trunc(max(20, tt))
```

<a id="sheet-unarmedattack"></a>

### Unarmed attack bonus

Formula ID: `unarmedAttack`. Inputs, in order: `strength`.

```text
result = trunc(((strength * 400) / 250))
```

<a id="sheet-twohandedattack"></a>

### Two-Handed attack bonus

Formula ID: `twoHandedAttack`. Inputs, in order: `base`, `flat`, `rate`.

```text
result = (flat + trunc(((base * rate) / 100)))
```

<a id="sheet-defenseseed"></a>

### Defense seed

Formula ID: `defenseSeed`. Inputs, in order: `stat`.

```text
result = (500 - trunc((250000 / (500 + trunc(((stat * 3) / 2))))))
```

<a id="sheet-defenserate"></a>

### Benchmark defense multiplier

Formula ID: `defenseRate`. Inputs, in order: `main`, `targetMain`, `defense`, `pierce`.

```text
defense = max(0, trunc(((defense * (100 - min(100, pierce))) / 100)))
userSeed = defenseSeed(main)
targetSeed = defenseSeed(targetMain)
denom = (userSeed + targetSeed)
scale = (4 * if (denom <= 0) then (userSeed * userSeed) else trunc(((userSeed * userSeed) / denom)))
if ((scale + defense) <= 0):
  result = 100
else:
  result = trunc(((100 * scale) / (scale + defense)))
```

<a id="sheet-benchmarkdamage"></a>

### Isolated damage benchmark

Formula ID: `benchmarkDamage`. Inputs, in order: `attack`, `main`, `basePower`, `attackRate`, `statRate`, `targetMain`, `defense`, `pierce`.

```text
power = (basePower + trunc(((attack * attackRate) / 100)))
raw = (power + trunc(((power * trunc(((main * statRate) / 100))) / 100)))
weighted = trunc(((main * statRate) / 100))
result = trunc(((raw * defenseRate(if (weighted = 0) then main else weighted, targetMain, defense, pierce)) / 100))
```

## Combat equations

<a id="combat-learninglp"></a>

### LP cost displayed in the native learn tree

Formula ID: `learningLP`. Inputs, in order: `jp`.

Fractional costs display two decimal places; stored costs and affordability use exact JP.

```text
result = (jp / 100)
```

<a id="combat-learningwholelp"></a>

### Whole LP sufficient for a JP cost

Formula ID: `learningWholeLP`. Inputs, in order: `jp`.

A conversion for whole LP input, not a rounded game cost.

```text
result = ceil((jp / 100))
```

<a id="combat-learningeligible"></a>

### JP affordability before learning prerequisites

Formula ID: `learningEligible`. Inputs, in order: `currentJP`, `costJP`.

Learning also requires unlocked skills and satisfied prerequisites.

```text
result = (currentJP >= costJP)
```

<a id="combat-percent"></a>

### Apply a percentage, truncating toward zero

Formula ID: `percent`. Inputs, in order: `amount`, `rate`.

Rates are percentage points: 100 means unchanged, 0 means zero. Truncate every division where shown, including negative healing values.

```text
result = trunc(((amount * rate) / 100))
```

<a id="combat-effectivemaximum"></a>

### Maximum resource used by periodic effects

Formula ID: `effectiveMaximum`. Inputs, in order: `maximum`.

```text
result = maximum
```

<a id="combat-dotresistance"></a>

### Vitality and Spirit adjustment to periodic HP

Formula ID: `dotResistance`. Inputs, in order: `rate`, `vitality`, `spirit`.

Positive rates damage HP; negative rates restore HP. Vitality reduces percentage DoT. Spirit increases percentage regeneration received. Neither stat changes flat-only periodic effects through this rule.

```text
if (rate > 0):
  result = (0 - trunc(((vitality * rate) / 100)))
else:
  if (rate < 0):
    result = trunc(((spirit * rate) / 100))
  else:
    result = 0
```

<a id="combat-periodichp"></a>

### HP damage or regeneration per tick

Formula ID: `periodicHP`. Inputs, in order: `maximum`, `rate`, `flat`, `percentDamageMultiplier`, `damageOverTimeMultiplier`, `healingOverTimeMultiplier`, `vitality`, `spirit`, `disableRecovery`.

Sum the active flat and additive-rate effects first. Multipliers affect the combined base, before Vitality/Spirit. Positive-rate damage cannot become healing. No hit roll, critical, direct-damage defense, or variance is applied. Apply the returned signed amount with applyResource.

```text
base = (trunc(((maximum * rate) / 100)) + flat)
if (base > 0):
  modified = trunc(((trunc(((base * percentDamageMultiplier) / 100)) * damageOverTimeMultiplier) / 100))
else:
  if (base < 0):
    modified = trunc(((base * healingOverTimeMultiplier) / 100))
  else:
    modified = base
resisted = (modified + dotResistance(rate, vitality, spirit))
if (rate > 0):
  bounded = max(0, resisted)
else:
  bounded = resisted
if (disableRecovery and (bounded < 0)):
  result = 0
else:
  result = bounded
```

<a id="combat-periodicresource"></a>

### MP or AP periodic change

Formula ID: `periodicResource`. Inputs, in order: `maximum`, `rate`, `flat`, `disableRecovery`.

MP and AP do not receive HP periodic multipliers or Vitality/Spirit adjustments.

```text
if disableRecovery:
  result = max(0, (trunc(((maximum * rate) / 100)) + flat))
else:
  result = (trunc(((maximum * rate) / 100)) + flat)
```

<a id="combat-heals"></a>

### Classify an ability as healing

Formula ID: `heals`. Inputs, in order: `ability`.

Healing classification uses the ability definition, not the sign of its final damage. A mixed-sign ability can be classified as healing.

```text
result = ((ability.BasePower < 0) or (ability.BasePAtkRate < 0) or ((ability.ScalingPower != none) and (ability.ScalingPower < 0)) or ((ability.ScalingPAtkRate != none) and (ability.ScalingPAtkRate < 0)) or (first(ability.AbilityMods, where mod: (includes([37, 38, 39, 42, 43, 44], mod.Tag) and (mod.Value1 < 0))) != none))
```

<a id="combat-actualscope"></a>

### Effective single or multi-target scope

Formula ID: `actualScope`. Inputs, in order: `user`, `ability`.

```text
if ((ability.Scope = 0) and (user has TargetMulti or (heals(ability) and not(includes([2, 4, 6], ability.Target)) and user has HealSingleToMulti))):
  result = 1
else:
  if (user has TargetSingleWithBonus and (ability.Scope != 0)):
    result = 0
  else:
    result = ability.Scope
```

<a id="combat-hpcost"></a>

### HP cost

Formula ID: `hpCost`. Inputs, in order: `user`, `ability`.

```text
result = max(0, trunc(((trunc(((user.Stats.HP * ability.HPCost) / 100)) * user.Stats.PercentDmgTakenMult) / 100)))
```

<a id="combat-mpcost"></a>

### MP cost

Formula ID: `mpCost`. Inputs, in order: `user`, `ability`.

Use the first matching per-ability cost entry. Clamp the flat subtotal before multiplying, not afterward.

```text
if false:
  result = 0
else:
  result = trunc(((max(0, (ability.MPCost + user.Stats.MPCostsFlat + first(user.Stats.AbilityMPCostFlat, where pair: (pair.ID = ability.ID)).Value (if record is none: 0))) * user.Stats.MPCostsMult) / 100))
```

<a id="combat-apcost"></a>

### AP cost

Formula ID: `apCost`. Inputs, in order: `user`, `ability`.

Use the first matching per-ability cost entry. Clamp the flat subtotal before multiplying, not afterward.

```text
if ((ability.ID = 45) and user has EscapeCostDown):
  result = 0
else:
  result = trunc(((max(0, (ability.APCost + user.Stats.APCostsFlat + first(user.Stats.AbilityAPCostFlat, where pair: (pair.ID = ability.ID)).Value (if record is none: 0))) * user.Stats.APCostsMult) / 100))
```

<a id="combat-chargetime"></a>

### Charge time

Formula ID: `chargeTime`. Inputs, in order: `user`, `ability`.

```text
if user has InstantCT:
  result = 0
else:
  result = trunc(((ability.CTCost * user.Stats.CTMult) / 100))
```

<a id="combat-cooldown"></a>

### Cooldown after an ability

Formula ID: `cooldown`. Inputs, in order: `user`, `ability`.

```text
if (ability.CDCost > 0):
  base = (ability.CDCost + user.Stats.CooldownsFlat)
else:
  base = ability.CDCost
if ((ability.CDCost > 0) and user has HalfCooldowns):
  halved = trunc((base / 2))
else:
  halved = base
if ((ability.CDCost > 0) and user has NoCooldowns):
  removed = 0
else:
  removed = halved
if ((ability.CDCost > 0) and user has CooldownsTo1):
  limited = min(removed, 1)
else:
  limited = removed
result = max(0, limited)
```

<a id="combat-itemconsumption"></a>

### Item consumption

Formula ID: `itemConsumption`. Inputs, in order: `baseCount`, `halved`.

```text
if halved:
  result = ceil((baseCount / 2))
else:
  result = baseCount
```

<a id="combat-nextturn"></a>

### Time until the next turn

Formula ID: `nextTurn`. Inputs, in order: `turnTime`, `freeAction`, `instantTurn`, `abilityMultiplier`.

Pass 100 when the ability has no NextTurnTTMult_100 modifier. Free actions and InstantTT bypass the ordinary turn-time minimum.

```text
if (freeAction or instantTurn):
  result = 0
else:
  result = trunc(((turnTime * abilityMultiplier) / 100))
```

<a id="combat-resourceterm"></a>

### Percentage-resource contribution to base damage

Formula ID: `resourceTerm`. Inputs, in order: `maximum`, `current`, `mode`, `rate`, `targetHP`, `percentDamageMultiplier`.

Mode 0 is current, 1 missing, 2 maximum. Only positive contributions from the target HP pool receive PercentDmgTakenMult. User resource terms do not.

Input requirements: Resource mode must be 0 current, 1 missing, or 2 maximum.

```text
if (targetHP and (trunc(((if (mode = 0) then current else if (mode = 1) then (maximum - current) else maximum * rate) / 100)) > 0)):
  result = trunc(((trunc(((if (mode = 0) then current else if (mode = 1) then (maximum - current) else maximum * rate) / 100)) * percentDamageMultiplier) / 100))
else:
  result = trunc(((if (mode = 0) then current else if (mode = 1) then (maximum - current) else maximum * rate) / 100))
```

<a id="combat-abilitypower"></a>

### Native power coefficient before resource and contextual effects

Formula ID: `abilityPower`. Inputs, in order: `attack`, `ability`, `extraPower`, `user`.

Each core-stat term truncates twice before the terms are added. extraPower is supplied by the contextual modifier stage.

```text
base = (ability.BasePower + trunc(((attack * ability.BasePAtkRate) / 100)) + extraPower)
scaling = (if (ability.ScalingPower = none) then ability.BasePower else ability.ScalingPower + trunc(((attack * if (ability.ScalingPAtkRate = none) then ability.BasePAtkRate else ability.ScalingPAtkRate) / 100)) + extraPower)
attributes = (trunc(((scaling * trunc(((user.Stats.Str * ability.StrRate) / 100))) / 100)) + trunc(((scaling * trunc(((user.Stats.Vit * ability.VitRate) / 100))) / 100)) + trunc(((scaling * trunc(((user.Stats.Dex * ability.DexRate) / 100))) / 100)) + trunc(((scaling * trunc(((user.Stats.Agi * ability.AgiRate) / 100))) / 100)) + trunc(((scaling * trunc(((user.Stats.Mnd * ability.MndRate) / 100))) / 100)) + trunc(((scaling * trunc(((user.Stats.Spi * ability.SpiRate) / 100))) / 100)) + trunc(((scaling * trunc(((user.Stats.Spd * ability.SpdRate) / 100))) / 100)) + trunc(((scaling * trunc(((user.Stats.Lck * ability.LckRate) / 100))) / 100)))
result = (base + attributes)
```

<a id="combat-basedamage"></a>

### Base ability damage or healing

Formula ID: `baseDamage`. Inputs, in order: `user`, `target`, `ability`, `context`.

Each of the eight attribute terms truncates twice and is added separately. An absent scaling override inherits the base coefficient; an explicit zero does not. Debuff and buff bonuses count unique statuses; Combo uses the target count.

```text
if ability.PDefAsPAtk:
  attack = user.Stats.PDef
else:
  attack = user.Stats.PAtk
extraPower = (if (ability modifier DamagePerTargetDebuff != none) then if (ability modifier DamagePerTargetDebuff.Value2 (if record is none: 0) = 0) then trunc(((attack * (ability modifier DamagePerTargetDebuff.Value1 (if record is none: 0) * context.targetDebuffCount)) / 100)) else (ability modifier DamagePerTargetDebuff.Value1 (if record is none: 0) * context.targetDebuffCount) else 0 + if (ability modifier DamagePerSelfBuff != none) then if (ability modifier DamagePerSelfBuff.Value2 (if record is none: 0) = 0) then trunc(((attack * (ability modifier DamagePerSelfBuff.Value1 (if record is none: 0) * context.userBuffCount)) / 100)) else (ability modifier DamagePerSelfBuff.Value1 (if record is none: 0) * context.userBuffCount) else 0 + if (ability modifier ConsumeComboTokens != none) then if (ability modifier ConsumeComboTokens.Value2 (if record is none: 0) = 0) then trunc(((attack * (ability modifier ConsumeComboTokens.Value1 (if record is none: 0) * first(target.Statuses, where status: (status.ID = 46)).Count (if record is none: 0))) / 100)) else (ability modifier ConsumeComboTokens.Value1 (if record is none: 0) * first(target.Statuses, where status: (status.ID = 46)).Count (if record is none: 0)) else 0)
power = abilityPower(attack, ability, extraPower, user)
resources = sum(ability.AbilityMods, for each mod: if (mod.Tag = 42) then if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 0) then resourceTerm(target.Stats.HP, target.HPCurrent, 0, mod.Value1, true, target.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 1) then resourceTerm(target.Stats.MP, target.MPCurrent, 0, mod.Value1, false, target.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 2) then resourceTerm(target.Stats.AP, target.APCurrent, 0, mod.Value1, false, target.Stats.PercentDmgTakenMult) else 0 else if (mod.Tag = 37) then if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 0) then resourceTerm(user.Stats.HP, user.HPCurrent, 0, mod.Value1, false, user.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 1) then resourceTerm(user.Stats.MP, user.MPCurrent, 0, mod.Value1, false, user.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 2) then resourceTerm(user.Stats.AP, user.APCurrent, 0, mod.Value1, false, user.Stats.PercentDmgTakenMult) else 0 else if (mod.Tag = 43) then if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 0) then resourceTerm(target.Stats.HP, target.HPCurrent, 1, mod.Value1, true, target.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 1) then resourceTerm(target.Stats.MP, target.MPCurrent, 1, mod.Value1, false, target.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 2) then resourceTerm(target.Stats.AP, target.APCurrent, 1, mod.Value1, false, target.Stats.PercentDmgTakenMult) else 0 else if (mod.Tag = 38) then if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 0) then resourceTerm(user.Stats.HP, user.HPCurrent, 1, mod.Value1, false, user.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 1) then resourceTerm(user.Stats.MP, user.MPCurrent, 1, mod.Value1, false, user.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 2) then resourceTerm(user.Stats.AP, user.APCurrent, 1, mod.Value1, false, user.Stats.PercentDmgTakenMult) else 0 else if (mod.Tag = 44) then if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 0) then resourceTerm(target.Stats.HP, target.HPCurrent, 2, mod.Value1, true, target.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 1) then resourceTerm(target.Stats.MP, target.MPCurrent, 2, mod.Value1, false, target.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 2) then resourceTerm(target.Stats.AP, target.APCurrent, 2, mod.Value1, false, target.Stats.PercentDmgTakenMult) else 0 else if (mod.Tag = 39) then if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 0) then resourceTerm(user.Stats.HP, user.HPCurrent, 2, mod.Value1, false, user.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 1) then resourceTerm(user.Stats.MP, user.MPCurrent, 2, mod.Value1, false, user.Stats.PercentDmgTakenMult) else if (if (mod.Value2 = 6) then ability.Attribute else mod.Value2 = 2) then resourceTerm(user.Stats.AP, user.APCurrent, 2, mod.Value1, false, user.Stats.PercentDmgTakenMult) else 0 else 0)
result = (power + resources)
```

<a id="combat-defenseseed"></a>

### Nonlinear defense seed

Formula ID: `defenseSeed`. Inputs, in order: `stat`.

```text
result = (500 - trunc((250000 / (500 + trunc(((stat * 3) / 2))))))
```

<a id="combat-defense"></a>

### Damage after defense and penetration

Formula ID: `defense`. Inputs, in order: `damage`, `user`, `target`, `ability`, `context`.

VIT and SPI enter the defense seed; they are not flat DEF/RES bonuses. Physical-only abilities use target VIT, magical-only use target SPI. Mixed or untyped abilities select by original defense coefficients. DamageHitsMDef redirects defense rates, not this attribute-selection rule.

```text
if (target.HPCurrent >= target.Stats.HP):
  physicalDefense = trunc(((target.Stats.PDef * target.Stats.PDefAtFullHPMult) / 100))
else:
  physicalDefense = target.Stats.PDef
if (target.HPCurrent >= target.Stats.HP):
  magicalDefense = trunc(((target.Stats.MDef * target.Stats.MDefAtFullHPMult) / 100))
else:
  magicalDefense = target.Stats.MDef
if target has PDefAsMDef:
  physicalDefense = magicalDefense
else:
  physicalDefense = physicalDefense
physicalDefense = trunc(((physicalDefense * (100 - min(100, user.Stats.PPen))) / 100))
magicalDefense = trunc(((magicalDefense * (100 - min(100, user.Stats.MPen))) / 100))
redirect = ((damage > 0) and user has DamageHitsMDef)
if redirect:
  physicalRate = 0
else:
  physicalRate = ability.PDefRate
if redirect:
  magicalRate = (ability.MDefRate + ability.PDefRate)
else:
  magicalRate = ability.MDefRate
baseDefense = max(0, (trunc(((physicalDefense * physicalRate) / 100)) + trunc(((magicalDefense * magicalRate) / 100))))
attackerMain = (trunc(((user.Stats.Str * ability.StrRate) / 100)) + trunc(((user.Stats.Vit * ability.VitRate) / 100)) + trunc(((user.Stats.Dex * ability.DexRate) / 100)) + trunc(((user.Stats.Agi * ability.AgiRate) / 100)) + trunc(((user.Stats.Mnd * ability.MndRate) / 100)) + trunc(((user.Stats.Spi * ability.SpiRate) / 100)) + trunc(((user.Stats.Spd * ability.SpdRate) / 100)) + trunc(((user.Stats.Lck * ability.LckRate) / 100)))
if (attackerMain = 0):
  if (ability.IsPAbil and not(ability.IsMAbil)):
    attackerMain = user.Stats.Str
  else:
    if (not(ability.IsPAbil) and ability.IsMAbil):
      attackerMain = user.Stats.Mnd
    else:
      attackerMain = trunc(((user.Stats.Str + user.Stats.Vit + user.Stats.Dex + user.Stats.Agi + user.Stats.Mnd + user.Stats.Spi + user.Stats.Spd + user.Stats.Lck) / 8))
else:
  attackerMain = attackerMain
if target has PDefAsMDef:
  physicalMain = target.Stats.Spi
else:
  physicalMain = target.Stats.Vit
if (ability.IsPAbil and not(ability.IsMAbil)):
  targetMain = physicalMain
else:
  if (not(ability.IsPAbil) and ability.IsMAbil):
    targetMain = target.Stats.Spi
  else:
    if (ability.PDefRate > ability.MDefRate):
      targetMain = physicalMain
    else:
      if (ability.PDefRate < ability.MDefRate):
        targetMain = target.Stats.Spi
      else:
        targetMain = trunc(((physicalMain + target.Stats.Spi) / 2))
attackerSeed = defenseSeed(attackerMain)
targetSeed = defenseSeed(targetMain)
seedTotal = (attackerSeed + targetSeed)
strength = (4 * if (seedTotal <= 0) then (attackerSeed * attackerSeed) else trunc(((attackerSeed * attackerSeed) / seedTotal)))
if ((strength + baseDefense) <= 0):
  rate = 100
else:
  rate = trunc(((100 * strength) / (strength + baseDefense)))
result = trunc(((damage * rate) / 100))
```

<a id="combat-criticaldamage"></a>

### Damage on a critical hit

Formula ID: `criticalDamage`. Inputs, in order: `damage`, `user`, `target`, `ability`.

Critical resistance reduces only the extra critical damage, including its flat component. It does not multiply the whole hit.

```text
if ability.IsPAbil:
  rate = trunc(((trunc((((ability.BaseCritDmg + user.Stats.PCritDmg) * user.Stats.PCritDmgGivenMult) / 100)) * target.Stats.PCritDmgTakenMult) / 100))
else:
  rate = ability.BaseCritDmg
if ability.IsPAbil:
  flat = (user.Stats.PCritDmgGivenFlat + target.Stats.PCritDmgTakenFlat)
else:
  flat = 0
extra = (trunc(((damage * rate) / 100)) + flat)
if (target.Stats.CritResist > 0):
  extra = trunc(((extra * min(100, max(0, (100 - target.Stats.CritResist)))) / 100))
else:
  extra = extra
result = (damage + extra)
```

<a id="combat-noncriticaldamage"></a>

### Damage on a noncritical hit

Formula ID: `noncriticalDamage`. Inputs, in order: `damage`, `user`, `target`, `ability`.

The given/taken percentages combine with integer truncation before multiplying the hit.

```text
result = trunc(((damage * if ability.IsPAbil then trunc(((trunc(((100 * user.Stats.PNonCritDmgGivenMult) / 100)) * target.Stats.PNonCritDmgTakenMult) / 100)) else 100) / 100))
```

<a id="combat-elementpass"></a>

### One element-multiplier pass

Formula ID: `elementPass`. Inputs, in order: `damage`, `multipliers`, `user`, `ability`.

Element bonuses within a pass all use the same entering damage and add. The given-element pass runs before the taken-element pass. Do not multiply all element rates together.

```text
result = (damage + if (ability.Element = none) then 0 else (trunc(((damage * multipliers[ability.Element]) / 100)) - damage) + if ability.IsPAbil then sum(user.Stats.PElements, for each element: if (element = ability.Element) then 0 else (trunc(((damage * multipliers[element]) / 100)) - damage)) else 0)
```

<a id="combat-repeatmultiplier"></a>

### Consecutive-use damage multiplier

Formula ID: `repeatMultiplier`. Inputs, in order: `multiplier`, `cap`, `repeats`.

A cap of exactly 100 does not clamp the computed rate in this executable.

```text
rate = max(0, (100 + ((multiplier - 100) * repeats)))
cap = max(0, cap)
if ((multiplier = 100) or (repeats <= 0)):
  result = 100
else:
  if (cap > 100):
    result = min(cap, max(100, rate))
  else:
    if (cap < 100):
      result = min(100, max(cap, rate))
    else:
      result = rate
```

<a id="combat-threatdamage"></a>

### Threat-position damage bonuses

Formula ID: `threatDamage`. Inputs, in order: `damage`, `user`, `target`, `ability`, `context`.

Only used for nonhealing member-to-monster actions. All threat bonuses share the entering damage. An ability bottom-threat bonus replaces the passive bottom-threat bonus. calcTestMode is the native preview flag, not an ordinary battle assumption.

```text
forceTop = (context.calcTestMode and ((ability modifier TopThreatDamageMult.Value1 (if record is none: 0) > 0) or (ability modifier NotBottomThreatDamageMult.Value1 (if record is none: 0) > 0) or (ability modifier BottomThreatDamageMult.Value1 (if record is none: 0) < 0) or (ability modifier NotTopThreatDamageMult.Value1 (if record is none: 0) < 0)))
forceBottom = (context.calcTestMode and ((ability modifier TopThreatDamageMult.Value1 (if record is none: 0) < 0) or (ability modifier NotBottomThreatDamageMult.Value1 (if record is none: 0) < 0) or (ability modifier BottomThreatDamageMult.Value1 (if record is none: 0) > 0) or (ability modifier NotTopThreatDamageMult.Value1 (if record is none: 0) > 0)))
bottom = ((context.bottomThreat and not(forceTop)) or forceBottom)
top = ((context.topThreat and not(forceBottom)) or forceTop)
if bottom:
  if (ability modifier BottomThreatDamageMult != none):
    bottomBonus = (trunc(((damage * (100 + ability modifier BottomThreatDamageMult.Value1 (if record is none: 0))) / 100)) - damage)
  else:
    if ability.IsPAbil:
      bottomBonus = (trunc(((damage * user.Stats.PDmgWithBottomThreatMult) / 100)) - damage)
    else:
      bottomBonus = 0
else:
  if (ability modifier NotBottomThreatDamageMult != none):
    bottomBonus = (trunc(((damage * (100 + ability modifier NotBottomThreatDamageMult.Value1 (if record is none: 0))) / 100)) - damage)
  else:
    bottomBonus = 0
if top:
  if (ability modifier TopThreatDamageMult != none):
    topBonus = (trunc(((damage * (100 + ability modifier TopThreatDamageMult.Value1 (if record is none: 0))) / 100)) - damage)
  else:
    topBonus = 0
else:
  if (ability modifier NotTopThreatDamageMult != none):
    topBonus = (trunc(((damage * (100 + ability modifier NotTopThreatDamageMult.Value1 (if record is none: 0))) / 100)) - damage)
  else:
    topBonus = 0
result = (damage + bottomBonus + topBonus)
```

<a id="combat-damagemodifiers"></a>

### Ordered damage and healing modifiers

Formula ID: `damageModifiers`. Inputs, in order: `damage`, `user`, `target`, `ability`, `context`.

The order is part of the formula. Physical and magical modifiers both apply to dual-type attacks. Caps occur before the on-kill multiplier and before random variance. mpShieldReduction is a signed MP change applied separately by AbilityProcessor; preserve it from the evaluation trace.

```text
healing = heals(ability)
if ability.IsBasic:
  basic = trunc(((damage * user.Stats.BasicAttackMult) / 100))
else:
  basic = damage
damage = basic
if healing:
  givenElements = damage
else:
  givenElements = elementPass(damage, user.Stats.ElementDmgGivenMults, user, ability)
if healing:
  takenElements = givenElements
else:
  takenElements = elementPass(givenElements, target.Stats.ElementDmgTakenMults, user, ability)
damage = takenElements
if healing:
  healingGiven = trunc(((damage * user.Stats.HealingGivenMult) / 100))
else:
  healingGiven = damage
damage = healingGiven
if (healing and not(context.sameBattler) and ((user.HPCurrent / user.Stats.HP) < (target.HPCurrent / target.Stats.HP))):
  selflessCure = trunc(((damage * user.Stats.SelflessCureMult) / 100))
else:
  selflessCure = damage
damage = selflessCure
if (healing and (target.HPCurrent <= target.HPCriticalValue)):
  criticalCure = trunc(((damage * user.Stats.CriticalCureMult) / 100))
else:
  criticalCure = damage
damage = criticalCure
if (not(healing) and ability.IsPAbil):
  physicalGiven = trunc(((damage * user.Stats.PDmgGivenMult) / 100))
else:
  physicalGiven = damage
damage = physicalGiven
if (not(healing) and ability.IsPAbil and (user.HPCurrent <= user.HPCriticalValue)):
  physicalGivenCritical = trunc(((damage * user.Stats.PDmgGivenWhenCriticalMult) / 100))
else:
  physicalGivenCritical = damage
damage = physicalGivenCritical
if (not(healing) and ability.IsMAbil):
  magicalGiven = trunc(((damage * user.Stats.MDmgGivenMult) / 100))
else:
  magicalGiven = damage
damage = magicalGiven
if (healing and (ability.Target != 4) and (ability.Target != 6)):
  healingTaken = trunc(((damage * target.Stats.HealingTakenMult) / 100))
else:
  healingTaken = damage
damage = healingTaken
if (not(healing) and ability.IsPAbil):
  physicalTaken = trunc(((damage * target.Stats.PDmgTakenMult) / 100))
else:
  physicalTaken = damage
damage = physicalTaken
if (not(healing) and ability.IsMAbil):
  magicalTaken = trunc(((damage * target.Stats.MDmgTakenMult) / 100))
else:
  magicalTaken = damage
damage = magicalTaken
if (not(healing) and user.IsMember and target.IsMonster):
  threat = threatDamage(damage, user, target, ability, context)
else:
  threat = damage
damage = threat
abilityBonus = trunc(((damage * first(user.Stats.AbilityDmgMult, where pair: (pair.ID = ability.ID)).Value (if record is none: 100)) / 100))
damage = abilityBonus
statuses = fold(ability.AbilityMods, start acc = damage; for each item at index: if ((item.Tag = if healing then 94 else 78) and (first(target.Statuses, where status: (status.ID = item.Value1)).Count (if record is none: 0) > 0)) then trunc(((acc * (100 + item.Value2)) / 100)) else acc)
damage = statuses
apCost = apCost(user, ability)
if ((apCost > 0) and user has DamageBonusFromAPCost):
  apBonus = (damage + trunc(((damage * trunc(((apCost * context.config.DamageBonusFromAPCostRate) / 100))) / 100)))
else:
  apBonus = damage
damage = apBonus
if (healing and (ability.Scope = 0) and user has HealSingleToMulti):
  multiHealing = (damage + trunc(((damage * (0 - context.config.HealMultiWithPenaltyRate)) / 100)))
else:
  multiHealing = damage
damage = multiHealing
if ((ability.Scope != 0) and user has TargetSingleWithBonus):
  singleTarget = (damage + trunc(((damage * context.config.TargetSingleWithBonusRate) / 100)))
else:
  singleTarget = damage
damage = singleTarget
if (not(healing) and ability.IsPAbil and (first(target.Statuses, where status: (status.ID = 11)).Count (if record is none: 0) > 0)):
  sleep = trunc(((damage * user.Stats.PDmgGivenAgainstSleepMult) / 100))
else:
  sleep = damage
damage = sleep
repeat = trunc(((damage * repeatMultiplier(user.Stats.RepeatActionDmgMult, user.Stats.RepeatActionDmgMultCap, context.repeatCount)) / 100))
damage = repeat
if (not(healing) and context.targetCharging):
  charging = trunc(((damage * target.Stats.DmgTakenWhileChargingMult) / 100))
else:
  charging = damage
damage = charging
if ((damage > 0) and (ability.Attribute = 1) and target has ImmuneToMPDmg):
  mpImmunity = 0
else:
  mpImmunity = damage
if target has InvertDamage:
  inverted = (0 - mpImmunity)
else:
  inverted = mpImmunity
damage = inverted
if ((damage > 0) and (ability.Attribute = 0) and target has MPShield):
  shielded = trunc(((damage * 75) / 100))
else:
  shielded = damage
mpShieldReduction = (shielded - damage)
damage = shielded
if (target.Stats.MaxDamageTaken = none):
  targetCap = damage
else:
  targetCap = min(damage, target.Stats.MaxDamageTaken)
if (user.Stats.MaxDamageGiven = none):
  userCap = targetCap
else:
  userCap = min(targetCap, user.Stats.MaxDamageGiven)
if (ability modifier MaxDamageGiven != none):
  abilityCap = min(userCap, ability modifier MaxDamageGiven.Value1 (if record is none: 0))
else:
  abilityCap = userCap
damage = abilityCap
if (ability.IsPAbil and (target.HPCurrent <= trunc(((damage * user.Stats.PDmgOnKillMult) / 100)))):
  onKill = trunc(((damage * user.Stats.PDmgOnKillMult) / 100))
else:
  onKill = damage
result = onKill
```

<a id="combat-damage"></a>

### Complete deterministic damage before randomness

Formula ID: `damage`. Inputs, in order: `user`, `target`, `ability`, `context`, `isCrit`.

Resolve hit and crit first. Then pass this signed result to resolvedDamage along with explicit random rolls.

```text
base = baseDamage(user, target, ability, context)
defended = defense(base, user, target, ability, context)
if isCrit:
  critical = criticalDamage(defended, user, target, ability)
else:
  critical = noncriticalDamage(defended, user, target, ability)
result = damageModifiers(critical, user, target, ability, context)
```

<a id="combat-variance"></a>

### Signed variance amplitude

Formula ID: `variance`. Inputs, in order: `damage`, `user`, `ability`.

```text
rate = (ability.BaseVar + if ability.IsPAbil then user.Stats.PVariance else 0)
if ability.IsMAbil:
  rate = trunc((((rate + user.Stats.MVariance) * user.Stats.MVarianceMult) / 100))
else:
  rate = rate
result = trunc(((damage * max(0, rate)) / 100))
```

<a id="combat-luckfactor"></a>

### Luck factor for a roll

Formula ID: `luckFactor`. Inputs, in order: `userLuck`, `targetLuck`, `activeLuckUp`.

activeLuckUp is the first LuckUp Value1 only while the user turn state is beyond ReadyToExecute and the active ability exists; otherwise pass 0. Steal and escape use the user as both user and target.

```text
result = max(0, trunc(f32((f32((trunc(((userLuck * (100 + activeLuckUp)) / 100)) - trunc((targetLuck / 2)))) * 0.75))))
```

<a id="combat-luckchance"></a>

### Chance after consecutive failures

Formula ID: `luckChance`. Inputs, in order: `chance`, `luck`, `failures`.

Do not truncate after multiplying by failures: the percentage increment truncates first. The raw threshold is not clamped; roll a uniform integer from 1 through 100 and succeed when roll <= threshold. A success resets the corresponding failure counter; a failure adds one. Hit, crit, and positive status application have separate counters; steal, escape, and chance damage share the miscellaneous counter.

```text
result = (chance + (trunc(((chance * luck) / 100)) * failures))
```

<a id="combat-difficultyhit"></a>

### Difficulty adjustment to hit chance

Formula ID: `difficultyHit`. Inputs, in order: `chance`, `modifier`.

Apply before luck. Select MemberHitChanceMod or MonsterHitChanceMod from the acting battler side and resolved encounter difficulty. Guaranteed 0/100 chances bypass this adjustment.

```text
if ((chance >= 1) and (chance <= 99)):
  result = min(100, max(0, (chance + modifier)))
else:
  result = chance
```

<a id="combat-rollsuccess"></a>

### Resolve a percent roll

Formula ID: `rollSuccess`. Inputs, in order: `threshold`, `roll`.

The caller supplies a uniform integer roll in [1,100]. This also resolves initial LootChance availability, separately from stealing.

Input requirements: Percent roll must be an integer from 1 through 100.

```text
result = (roll <= threshold)
```

<a id="combat-failurecounter"></a>

### Update a failure counter

Formula ID: `failureCounter`. Inputs, in order: `previous`, `success`.

```text
if success:
  result = 0
else:
  result = (previous + 1)
```

<a id="combat-varianceroll"></a>

### Luck-adjusted variance roll

Formula ID: `varianceRoll`. Inputs, in order: `luck`, `fullRolls`, `partialRoll`.

fullRolls contains exactly 1 + trunc(luck/100) independent uniform integers in [0,200]. Draw partialRoll in [0,200] only when luck%100 > 0; otherwise pass 0. The two weighted partial terms truncate separately.

Input requirements: Luck factor must be a nonnegative signed integer; Incorrect number of full variance rolls for the supplied Luck; Variance rolls must be integers from 0 through 200; Partial variance roll must be an integer from 0 through 200; use 0 when no partial roll is drawn.

```text
best = fold(fullRolls, start acc = fullRolls[0]; for each item at index: max(acc, item))
remainder = (luck % 100)
if ((remainder > 0) and (partialRoll > best)):
  result = (trunc(((best * (100 - remainder)) / 100)) + trunc(((partialRoll * remainder) / 100)))
else:
  result = best
```

<a id="combat-variancedelta"></a>

### Variance added to a signed amount

Formula ID: `varianceDelta`. Inputs, in order: `amplitude`, `roll`.

```text
result = trunc(((amplitude * (roll - 100)) / 100))
```

<a id="combat-resolveddamage"></a>

### Post-variance damage and survival guards

Formula ID: `resolvedDamage`. Inputs, in order: `damage`, `varianceDelta`, `user`, `target`, `ability`, `context`, `miscRoll`, `luck`, `miscFailures`.

The one-hit-KO guard in this executable has no HP-attribute check. The chance multiplier uses the miscellaneous failure counter only when its tag exists. Apply no-overflow and survival checks after randomness; do not reapply earlier damage caps.

```text
if (damage >= 0):
  varied = max(0, (damage + varianceDelta))
else:
  varied = min(0, (damage + varianceDelta))
if ((ability modifier ChanceForDamageMult != none) and rollSuccess(luckChance(ability modifier ChanceForDamageMult.Value1 (if record is none: 0), luck, miscFailures), miscRoll)):
  chanceMultiplier = trunc(((varied * ability modifier ChanceForDamageMult.Value2 (if record is none: 0)) / 100))
else:
  chanceMultiplier = varied
if (ability.Attribute = 0):
  resourceCurrent = target.HPCurrent
else:
  if (ability.Attribute = 1):
    resourceCurrent = target.MPCurrent
  else:
    resourceCurrent = target.APCurrent
if ((ability modifier DamageReturnRateNoOverflow_100 != none) and includes([0, 1, 2], ability.Attribute)):
  noOverflow = min(chanceMultiplier, resourceCurrent)
else:
  noOverflow = chanceMultiplier
if ((ability.Attribute = 0) and (noOverflow >= target.HPCurrent) and ((ability.IsPAbil and user has PDmgCannotKill) or (ability.IsMAbil and user has MDmgCannotKill))):
  cannotKill = max(0, (target.HPCurrent - 1))
else:
  cannotKill = noOverflow
if (target has CantBeOneHitKOd and (target.HPCurrent >= target.Stats.HP) and (cannotKill >= target.HPCurrent) and (cannotKill > 1)):
  result = (target.HPCurrent - 1)
else:
  result = cannotKill
```

<a id="combat-curvesegment"></a>

### Native single-precision curve interpolation

Formula ID: `curveSegment`. Inputs, in order: `position`, `leftX`, `leftY`, `rightX`, `rightY`.

Preserve every f32 operation. Although linear tangents describe a straight segment mathematically, replacing this evaluation with ordinary double-precision linear interpolation changes some truncated results.

```text
t = f32((f32((f32(position) - f32(leftX))) / f32((f32(rightX) - f32(leftX)))))
t2 = f32((t * t))
t3 = f32((t2 * t))
tangent = f32((f32(rightY) - f32(leftY)))
a = f32((f32((f32((f32((2 * t3)) - f32((3 * t2)))) + 1)) * f32(leftY)))
b = f32((f32((f32((t3 - f32((2 * t2)))) + t)) * tangent))
c = f32((f32((f32((3 * t2)) - f32((2 * t3)))) * f32(rightY)))
d = f32((f32((t3 - t2)) * tangent))
result = f32((f32((f32((a + b)) + c)) + d))
```

<a id="combat-hitcurve"></a>

### hit Curve

Formula ID: `hitCurve`. Inputs, in order: `position`.

Outside the table, retain the nearest endpoint value.

```text
if (f32(position) < f32(0)):
  result = f32(0)
else:
  if (f32(position) <= f32(0.25)):
    result = curveSegment(position, 0, 0, 0.25, 0.2)
  else:
    if (f32(position) <= f32(0.5)):
      result = curveSegment(position, 0.25, 0.2, 0.5, 0.5)
    else:
      if (f32(position) <= f32(0.75)):
        result = curveSegment(position, 0.5, 0.5, 0.75, 0.8)
      else:
        if (f32(position) <= f32(0.875)):
          result = curveSegment(position, 0.75, 0.8, 0.875, 0.9)
        else:
          if (f32(position) <= f32(1)):
            result = curveSegment(position, 0.875, 0.9, 1, 0.95)
          else:
            if (f32(position) <= f32(1.25)):
              result = curveSegment(position, 1, 0.95, 1.25, 0.98)
            else:
              if (f32(position) <= f32(1.5)):
                result = curveSegment(position, 1.25, 0.98, 1.5, 1)
              else:
                result = f32(1)
```

<a id="combat-explevelcurve"></a>

### exp Level Curve

Formula ID: `expLevelCurve`. Inputs, in order: `position`.

Outside the table, retain the nearest endpoint value.

```text
if (f32(position) < f32(-10)):
  result = f32(0)
else:
  if (f32(position) <= f32(-5)):
    result = curveSegment(position, -10, 0, -5, 0.35)
  else:
    if (f32(position) <= f32(0)):
      result = curveSegment(position, -5, 0.35, 0, 1)
    else:
      if (f32(position) <= f32(5)):
        result = curveSegment(position, 0, 1, 5, 1.2)
      else:
        if (f32(position) <= f32(10)):
          result = curveSegment(position, 5, 1.2, 10, 1.2)
        else:
          result = f32(1.2)
```

<a id="combat-jplevelcurve"></a>

### jp Level Curve

Formula ID: `jpLevelCurve`. Inputs, in order: `position`.

Outside the table, retain the nearest endpoint value.

```text
if (f32(position) < f32(-10)):
  result = f32(0.8)
else:
  if (f32(position) <= f32(-5)):
    result = curveSegment(position, -10, 0.8, -5, 0.9)
  else:
    if (f32(position) <= f32(0)):
      result = curveSegment(position, -5, 0.9, 0, 1)
    else:
      if (f32(position) <= f32(5)):
        result = curveSegment(position, 0, 1, 5, 1.2)
      else:
        if (f32(position) <= f32(10)):
          result = curveSegment(position, 5, 1.2, 10, 1.4)
        else:
          result = f32(1.4)
```

<a id="combat-cumulativejpcurve"></a>

### cumulative J P Curve

Formula ID: `cumulativeJPCurve`. Inputs, in order: `position`.

Outside the table, retain the nearest endpoint value.

```text
if (f32(position) < f32(0)):
  result = f32(1.5)
else:
  if (f32(position) <= f32(200)):
    result = curveSegment(position, 0, 1.5, 200, 1.5)
  else:
    if (f32(position) <= f32(300)):
      result = curveSegment(position, 200, 1.5, 300, 1.4)
    else:
      if (f32(position) <= f32(400)):
        result = curveSegment(position, 300, 1.4, 400, 1.25)
      else:
        if (f32(position) <= f32(600)):
          result = curveSegment(position, 400, 1.25, 600, 1.125)
        else:
          if (f32(position) <= f32(1000)):
            result = curveSegment(position, 600, 1.125, 1000, 1)
          else:
            result = f32(1)
```

<a id="combat-trooprewardcurve"></a>

### troop Reward Curve

Formula ID: `troopRewardCurve`. Inputs, in order: `position`.

Outside the table, retain the nearest endpoint value.

```text
if (f32(position) < f32(1)):
  result = f32(1)
else:
  if (f32(position) <= f32(2)):
    result = curveSegment(position, 1, 1, 2, 0.95)
  else:
    if (f32(position) <= f32(3)):
      result = curveSegment(position, 2, 0.95, 3, 0.9)
    else:
      if (f32(position) <= f32(4)):
        result = curveSegment(position, 3, 0.9, 4, 0.85)
      else:
        if (f32(position) <= f32(6)):
          result = curveSegment(position, 4, 0.85, 6, 0.8)
        else:
          if (f32(position) <= f32(8)):
            result = curveSegment(position, 6, 0.8, 8, 0.75)
          else:
            result = f32(0.75)
```

<a id="combat-defeatlosscapcurve"></a>

### defeat Loss Cap Curve

Formula ID: `defeatLossCapCurve`. Inputs, in order: `position`.

Outside the table, retain the nearest endpoint value.

```text
if (f32(position) < f32(1)):
  result = f32(0)
else:
  if (f32(position) <= f32(9)):
    result = curveSegment(position, 1, 0, 9, 0)
  else:
    if (f32(position) <= f32(10)):
      result = curveSegment(position, 9, 0, 10, 1)
    else:
      if (f32(position) <= f32(11)):
        result = curveSegment(position, 10, 1, 11, 2)
      else:
        if (f32(position) <= f32(12)):
          result = curveSegment(position, 11, 2, 12, 3)
        else:
          if (f32(position) <= f32(13)):
            result = curveSegment(position, 12, 3, 13, 5)
          else:
            if (f32(position) <= f32(14)):
              result = curveSegment(position, 13, 5, 14, 7)
            else:
              if (f32(position) <= f32(15)):
                result = curveSegment(position, 14, 7, 15, 9)
              else:
                if (f32(position) <= f32(20)):
                  result = curveSegment(position, 15, 9, 20, 20)
                else:
                  if (f32(position) <= f32(25)):
                    result = curveSegment(position, 20, 20, 25, 50)
                  else:
                    if (f32(position) <= f32(30)):
                      result = curveSegment(position, 25, 50, 30, 200)
                    else:
                      if (f32(position) <= f32(36)):
                        result = curveSegment(position, 30, 200, 36, 1000)
                      else:
                        if (f32(position) <= f32(40)):
                          result = curveSegment(position, 36, 1000, 40, 2000)
                        else:
                          if (f32(position) <= f32(50)):
                            result = curveSegment(position, 40, 2000, 50, 5000)
                          else:
                            if (f32(position) <= f32(60)):
                              result = curveSegment(position, 50, 5000, 60, 10000)
                            else:
                              result = f32(10000)
```

<a id="combat-physicalhitcurve"></a>

### Base physical accuracy/evasion curve

Formula ID: `physicalHitCurve`. Inputs, in order: `accuracy`, `evasion`.

Zero evasion yields 100 before ability accuracy, modifiers, difficulty, Luck and miss protection.

```text
if (evasion > 0):
  result = trunc(f32((hitCurve(f32((f32(accuracy) / f32(evasion)))) * 100)))
else:
  result = 100
```

<a id="combat-ordinaryhitchance"></a>

### Hit chance without early-exit flags

Formula ID: `ordinaryHitChance`. Inputs, in order: `user`, `target`, `ability`, `context`.

Physical takes precedence over magical for hybrid abilities. Zero target evasion bypasses physical hit modifiers. PerfectHit is checked before PerfectDodge.

```text
if (target.Stats.PEvaRating > 0):
  physical = trunc(((trunc((((ability.BaseAcc + physicalHitCurve(user.Stats.PAccRating, target.Stats.PEvaRating) + user.Stats.PHitChanceGivenAddi + target.Stats.PHitChanceTakenAddi) * user.Stats.PHitChanceGivenMult) / 100)) * target.Stats.PHitChanceTakenMult) / 100))
else:
  physical = (ability.BaseAcc + 100)
if ability.IsPAbil:
  chance = physical
else:
  if ability.IsMAbil:
    chance = (ability.BaseAcc + 100 + user.Stats.MHitChanceGivenAddi + target.Stats.MHitChanceTakenAddi)
  else:
    chance = (ability.BaseAcc + 100)
if (user has PerfectHit and (chance >= context.config.PerfectHitAtChanceOrHigher) and (chance < 100)):
  result = 100
else:
  if (target has PerfectDodge and (chance <= context.config.PerfectDodgeAtChanceOrLower) and (chance > 0)):
    result = 0
  else:
    result = min(100, max(0, chance))
```

<a id="combat-hitchance"></a>

### Hit chance with flags and status requirements

Formula ID: `hitChance`. Inputs, in order: `user`, `target`, `ability`, `context`.

Forced misses precede guaranteed hits, which precede a fixed hit rate. Fixed hit rates return directly without clamping or PerfectHit/PerfectDodge. Next apply difficultyHit and luckChance before rolling.

```text
if ((ability.IsPAbil and (actualScope(user, ability) != 0) and target has DodgeIndirectPAoe and user.IsMonster and not(context.targetIsThreatTarget)) or ((first(ability.AbilityMods, where mod: ((mod.Tag = 23) and (first(target.Statuses, where status: (status.ID = mod.Value1)).Count (if record is none: 0) <= 0))) != none) or (first(ability.AbilityMods, where mod: ((mod.Tag = 26) and (first(user.Statuses, where status: (status.ID = mod.Value1)).Count (if record is none: 0) <= 0))) != none) or (first(ability.AbilityMods, where mod: ((mod.Tag = 27) and (first(target.Statuses, where status: (status.ID = mod.Value1)).Count (if record is none: 0) > 0))) != none) or (first(ability.AbilityMods, where mod: ((mod.Tag = 28) and (first(user.Statuses, where status: (status.ID = mod.Value1)).Count (if record is none: 0) > 0))) != none)) or ((ability.Element = 3) and target has Float) or (user.IsMember and target.IsMonster and (ability modifier NotBottomThreatAlwaysMiss != none) and not(context.bottomThreat) and not(context.calcTestMode)) or (ability.IsPAbil and (user has PHit_Never or target has PEva_Always)) or (ability.IsMAbil and (user has MHit_Never or target has MEva_Always))):
  result = 0
else:
  if ((ability modifier NeverMiss != none) or (ability.IsPAbil and (user has PHit_Always or target has PEva_Never)) or (ability.IsMAbil and (user has MHit_Always or target has MEva_Never))):
    result = 100
  else:
    if (ability modifier FixedHitRate_100 != none):
      result = ability modifier FixedHitRate_100.Value1 (if record is none: 0)
    else:
      result = ordinaryHitChance(user, target, ability, context)
```

<a id="combat-critchance"></a>

### Critical-hit chance

Formula ID: `critChance`. Inputs, in order: `user`, `target`, `ability`.

Always/Never Crit flags are gated by physical type or a positive ability base critical chance. Apply luckChance before the actual roll.

```text
if (target has CritImmunity or ((ability.IsPAbil or (ability.BaseCritChance > 0)) and ((ability modifier NeverCrit != none) or user has CritNever))):
  result = 0
else:
  if ((ability.IsPAbil or (ability.BaseCritChance > 0)) and ((ability modifier AlwaysCrit != none) or user has CritAlways)):
    result = 100
  else:
    result = min(100, max(0, if ability.IsPAbil then trunc(((trunc((((ability.BaseCritChance + user.Stats.PCritChance) * user.Stats.PCritChanceGivenMult) / 100)) * target.Stats.PCritChanceTakenMult) / 100)) else ability.BaseCritChance))
```

<a id="combat-statuschance"></a>

### Status chance after immunities

Formula ID: `statusChance`. Inputs, in order: `chance`, `immuneByID`, `immuneByCategory`, `resistsReapplication`, `previouslyApplied`.

```text
if (immuneByID or immuneByCategory or (resistsReapplication and previouslyApplied)):
  result = 0
else:
  result = chance
```

<a id="combat-statusduration"></a>

### Status duration or stack count

Formula ID: `statusDuration`. Inputs, in order: `count`, `category`, `permanentBuffs`, `permanentDebuffs`, `receivedFlat`, `appliedFlat`, `receivedAdditive`, `appliedAdditive`.

Category 1 is buff and 2 debuff. Supply the corresponding target duration and user apply-duration bonuses. Negative removal counts and permanent count 255 pass through. Flat adjustments precede additive percentages.

```text
flatCount = (count + receivedFlat + appliedFlat)
modified = (flatCount + trunc(((flatCount * (receivedAdditive + appliedAdditive)) / 100)))
if ((count < 0) or (count = 255) or not(includes([1, 2], category))):
  result = count
else:
  if (((category = 1) and permanentBuffs) or ((category = 2) and permanentDebuffs)):
    result = 255
  else:
    result = min(254, max(0, modified))
```

<a id="combat-statusroll"></a>

### Status application or removal roll

Formula ID: `statusRoll`. Inputs, in order: `count`, `canApply`, `canRemove`, `chance`, `luck`, `failures`, `roll`.

Pass the immunity-adjusted chance for positive applications. Removal does not use Luck or the failure counter. An ineligible or zero-count attempt returns without changing the counter.

```text
if (count > 0):
  result = (canApply and rollSuccess(luckChance(chance, luck, failures), roll))
else:
  if (count < 0):
    result = (canRemove and rollSuccess(chance, roll))
  else:
    result = false
```

<a id="combat-stealchance"></a>

### Steal chance for one available loot entry

Formula ID: `stealChance`. Inputs, in order: `baseChance`, `stealChanceUp`.

This is not LootChance, the separate availability roll. A StealChanceUp total of -100 divides by zero and is invalid. Apply Luck against the user and the shared miscellaneous failure counter per attempt.

```text
result = trunc(((100 * (baseChance + stealChanceUp)) / (100 + stealChanceUp)))
```

<a id="combat-combinedstealchance"></a>

### Displayed chance to steal at least one remaining item

Formula ID: `combinedStealChance`. Inputs, in order: `chances`.

Pass per-entry steal chances for the remaining available loot entries in their native order. This display calculation is not the sequence of actual rolls.

```text
result = trunc(fold(chances, start acc = 0; for each item at index: f32((acc + f32((f32((f32((100 - acc)) * f32(item))) / 100))))))
```

<a id="combat-escapechance"></a>

### Base escape chance

Formula ID: `escapeChance`. Inputs, in order: `userLevel`, `livingPresentEnemyLevels`, `perfectEscape`.

Supply only alive and present enemies; a non-perfect escape requires at least one. Then apply Luck against the user and the shared miscellaneous failure counter.

```text
if perfectEscape:
  result = 100
else:
  result = min(100, max(20, (80 + ((userLevel - trunc((sum(livingPresentEnemyLevels, for each level: level) / sum(livingPresentEnemyLevels, for each level: 1)))) * 5))))
```

<a id="combat-damagereturn"></a>

### Lifesteal, resource return, and recoil

Formula ID: `damageReturn`. Inputs, in order: `actualDamage`, `overflowDamage`, `killDamage`, `user`, `ability`, `attribute`.

Return amounts are signed damage to the user: negative restores resources. KillsUser/KillsUserAlmost return immediately for HP and bypass recovery suppression. Supply actual, potential including overflow, and on-kill damage accumulated by AbilityProcessor, not the same number in all three slots.

```text
killMod = first(ability.AbilityMods, where mod: includes([45, 47], mod.Tag))
abilityReturn = sum(ability.AbilityMods, for each mod: if (mod.Value1 = attribute) then if (mod.Tag = 40) then trunc(((overflowDamage * mod.Value2) / 100)) else if (mod.Tag = 46) then trunc(((actualDamage * mod.Value2) / 100)) else if (mod.Tag = 41) then trunc(((killDamage * mod.Value2) / 100)) else 0 else 0)
if (attribute = 0):
  statReturn = (if ability.IsPAbil then (if (overflowDamage > 0) then (user.Stats.PDmgHPReturnFlat + trunc(((overflowDamage * user.Stats.PDmgHPReturnAddi) / 100))) else 0 + if (killDamage > 0) then trunc(((killDamage * user.Stats.PDmgHPReturnOnKillAddi) / 100)) else 0) else 0 + if ability.IsMAbil then (if (overflowDamage > 0) then trunc(((overflowDamage * user.Stats.MDmgHPReturnAddi) / 100)) else 0 + if (killDamage > 0) then trunc(((killDamage * user.Stats.MDmgHPReturnOnKillAddi) / 100)) else 0) else 0 + if (heals(ability) and (overflowDamage < 0)) then trunc(((overflowDamage * user.Stats.HealingHPReturnAddi) / 100)) else 0)
else:
  if (attribute = 1):
    statReturn = (if ability.IsPAbil then (if (overflowDamage > 0) then (user.Stats.PDmgMPReturnFlat + trunc(((overflowDamage * user.Stats.PDmgMPReturnAddi) / 100))) else 0 + if (killDamage > 0) then trunc(((killDamage * user.Stats.PDmgMPReturnOnKillAddi) / 100)) else 0) else 0 + if ability.IsMAbil then (if (overflowDamage > 0) then trunc(((overflowDamage * user.Stats.MDmgMPReturnAddi) / 100)) else 0 + if (killDamage > 0) then trunc(((killDamage * user.Stats.MDmgMPReturnOnKillAddi) / 100)) else 0) else 0 + if (heals(ability) and (overflowDamage < 0)) then trunc(((overflowDamage * user.Stats.HealingMPReturnAddi) / 100)) else 0)
  else:
    if (attribute = 2):
      statReturn = (if ability.IsPAbil then (if (overflowDamage > 0) then (user.Stats.PDmgAPReturnFlat + trunc(((overflowDamage * user.Stats.PDmgAPReturnAddi) / 100))) else 0 + if (killDamage > 0) then trunc(((killDamage * user.Stats.PDmgAPReturnOnKillAddi) / 100)) else 0) else 0 + if ability.IsMAbil then (if (overflowDamage > 0) then trunc(((overflowDamage * user.Stats.MDmgAPReturnAddi) / 100)) else 0 + if (killDamage > 0) then trunc(((killDamage * user.Stats.MDmgAPReturnOnKillAddi) / 100)) else 0) else 0 + if (heals(ability) and (overflowDamage < 0)) then trunc(((overflowDamage * user.Stats.HealingAPReturnAddi) / 100)) else 0)
    else:
      statReturn = 0
if ((ability.Attribute = attribute) and heals(ability) and (overflowDamage < 0)):
  healingReturn = trunc(((overflowDamage * user.Stats.HealingReturnAddi) / 100))
else:
  healingReturn = 0
total = (abilityReturn + statReturn + healingReturn)
if ((attribute = 0) and (killMod != none)):
  if (killMod.Tag (if record is none: 0) = 45):
    result = user.Stats.HP
  else:
    result = max(0, (user.HPCurrent - 1))
else:
  if ((total < 0) and user has DisableLifestealAndRegen):
    result = 0
  else:
    result = total
```

<a id="combat-assistrewardrate"></a>

### Select an EXP or JP assist multiplier

Formula ID: `assistRewardRate`. Inputs, in order: `lessEnabled`, `lessRate`, `boostEnabled`, `boostRate`.

Use the EXP or JXP flags for the relevant reward. Less takes priority only when enabled with a non-100 rate.

```text
if (lessEnabled and (lessRate != 100)):
  result = lessRate
else:
  if (boostEnabled and (boostRate != 100)):
    result = boostRate
  else:
    result = 100
```

<a id="combat-expreward"></a>

### EXP reward per monster and member

Formula ID: `expReward`. Inputs, in order: `reward`, `monsterLevel`, `memberLevel`, `troopSize`, `boss`, `alive`, `expBoostRate`, `assistRate`.

Boss EXP bypasses level, troop-size, and death penalties; boosts still apply. The member level is capped at 60 only for the level-difference lookup.

```text
if boss:
  rate = 1
else:
  rate = f32((f32((expLevelCurve((monsterLevel - min(60, memberLevel))) * troopRewardCurve(troopSize))) * if alive then 1 else 0.75))
if (expBoostRate != 100):
  rate = f32((rate * f32((f32(expBoostRate) * f32(0.01)))))
else:
  rate = rate
if (assistRate != 100):
  rate = f32((rate * f32((f32(assistRate) * f32(0.01)))))
else:
  rate = rate
if (reward > 0):
  result = trunc(f32((f32((f32(reward) * rate)) + 0.25)))
else:
  result = 0
```

<a id="combat-jpreward"></a>

### JP reward per monster and member

Formula ID: `jpReward`. Inputs, in order: `reward`, `monsterLevel`, `memberLevel`, `troopSize`, `totalJobJP`, `boss`, `alive`, `jobBoostRate`, `allJobBoostRate`, `assistRate`.

Use total accumulated JP in the current job, not unspent JP. Bosses impose a minimum rate of 1 after ordinary penalties and before boosts. Use the first matching per-job boost; pass 100 if absent.

```text
rate = f32((f32((cumulativeJPCurve(totalJobJP) * jpLevelCurve((monsterLevel - min(60, memberLevel))))) * troopRewardCurve(troopSize)))
if alive:
  rate = rate
else:
  rate = f32((rate * 0.75))
if (boss and (rate < 1)):
  rate = 1
else:
  rate = rate
rate = f32((rate * f32((f32(jobBoostRate) * f32(0.01)))))
if (allJobBoostRate != 100):
  rate = f32((rate * f32((f32(allJobBoostRate) * f32(0.01)))))
else:
  rate = rate
if (assistRate != 100):
  rate = f32((rate * f32((f32(assistRate) * f32(0.01)))))
else:
  rate = rate
if (reward > 0):
  result = trunc(f32((f32((f32(reward) * rate)) + 0.25)))
else:
  result = 0
```

<a id="combat-defeatcurrencyloss"></a>

### Currency lost on defeat

Formula ID: `defeatCurrencyLoss`. Inputs, in order: `remainingEnemyMoney`, `presentMemberLevels`, `currency`, `lossEnabled`.

remainingEnemyMoney is the sum from alive, present enemies. The average level includes all present members, alive or dead. The caller supplies the native defeat-loss eligibility flag.

```text
if lossEnabled:
  result = max(0, min(remainingEnemyMoney, trunc(defeatLossCapCurve(if (sum(presentMemberLevels, for each level: 1) > 0) then trunc((sum(presentMemberLevels, for each level: level) / sum(presentMemberLevels, for each level: 1))) else 0)), trunc((currency / 10))))
else:
  result = 0
```

<a id="combat-difficultystat"></a>

### Enemy attribute or equipment input after difficulty

Formula ID: `difficultyStat`. Inputs, in order: `base`, `rate`.

```text
result = trunc(((base * rate) / 100))
```

<a id="combat-difficultyvital"></a>

### Enemy HP or MP after difficulty

Formula ID: `difficultyVital`. Inputs, in order: `base`, `rate`.

Choose the boss or ordinary-enemy HP/MP rate from the selected native difficulty. Round only when the rate differs from 100.

```text
scaled = trunc(((base * rate) / 100))
if (rate = 100):
  result = base
else:
  if (scaled < 100):
    result = (trunc(((scaled + 2) / 5)) * 5)
  else:
    result = (trunc(((scaled + 5) / 10)) * 10)
```

<a id="combat-applyresource"></a>

### Resource remaining after signed damage

Formula ID: `applyResource`. Inputs, in order: `current`, `maximum`, `damage`, `locked`.

Only MP uses MPLock. Positive amounts remove resources; negative amounts restore them. Death, revival, and reactions are separate state transitions.

```text
if locked:
  result = current
else:
  result = min(maximum, max(0, (current - damage)))
```

<a id="combat-actualresourcedamage"></a>

### Actual damage or recovery reported by application

Formula ID: `actualResourceDamage`. Inputs, in order: `current`, `maximum`, `damage`.

The native returned amount is bounded independently of MPLock, even when locked MP does not change.

```text
if (damage > 0):
  result = min(current, max(0, damage))
else:
  if (damage < 0):
    result = min(0, max((current - maximum), damage))
  else:
    result = damage
```

<a id="combat-spendresource"></a>

### Resource remaining after paying a positive cost

Formula ID: `spendResource`. Inputs, in order: `current`, `maximum`, `cost`, `minimum`, `locked`.

HP costs retain at least 1 HP. MP and AP retain at least 0. Only MP respects MPLock.

```text
if ((cost > 0) and not(locked)):
  result = min(maximum, max(minimum, (current - cost)))
else:
  result = current
```

<a id="combat-accumulateap"></a>

### AP after an accumulation event

Formula ID: `accumulateAP`. Inputs, in order: `current`, `maximum`, `baseGain`, `bonus`, `multiplier`.

Base gain is 6 on turn, basic attack, or surviving opposing physical damage; 0 on battle start or magic. Ability AccumulateAP modifiers add their Value1 values. Recovery-on-AP uses the actual increase after the capacity clamp.

```text
result = min(maximum, max(0, (current + trunc((((baseGain + bonus) * multiplier) / 100)))))
```

<a id="combat-aphprecovery"></a>

### HP recovered from an actual AP gain

Formula ID: `apHPRecovery`. Inputs, in order: `actualGain`, `maximumHP`, `enabled`.

```text
if (enabled and (actualGain > 0)):
  result = (0 - trunc(((actualGain * maximumHP) / 100)))
else:
  result = 0
```

<a id="combat-apmprecovery"></a>

### MP recovered from an actual AP gain

Formula ID: `apMPRecovery`. Inputs, in order: `actualGain`, `enabled`.

```text
if (enabled and (actualGain > 0)):
  result = (0 - actualGain)
else:
  result = 0
```

<a id="combat-hpalert"></a>

### Low-HP threshold

Formula ID: `hpAlert`. Inputs, in order: `maximumHP`.

```text
result = trunc((maximumHP / 2))
```

<a id="combat-hpcritical"></a>

### Critical-HP threshold

Formula ID: `hpCritical`. Inputs, in order: `maximumHP`.

```text
result = trunc((maximumHP / 4))
```

<a id="combat-absorbedhp"></a>

### Maximum HP gained by eligible physical damage

Formula ID: `absorbedHP`. Inputs, in order: `previous`, `damage`, `rate`, `eligible`.

Pass PDmgIncreasesMaxHPAbsorbRate from battleConfig. Add absorbed HP after ordinary HP multipliers and before the member cap.

```text
if (eligible and (damage > 0)):
  result = (previous + trunc(((damage * rate) / 100)))
else:
  result = previous
```

<a id="combat-absorbedhpdecay"></a>

### Remaining absorbed maximum HP

Formula ID: `absorbedHPDecay`. Inputs, in order: `previous`, `rate`, `stillEnabled`.

```text
if stillEnabled:
  result = max(0, (previous - trunc(((previous * rate) / 100))))
else:
  result = 0
```

<a id="combat-convertresourcegain"></a>

### Resource gained by conversion

Formula ID: `convertResourceGain`. Inputs, in order: `sourceCurrent`, `targetMissing`, `rate`.

MP to HP rate is 1000. MP to AP and AP to MP rate is 100. Application still obeys resource clamps and MPLock.

```text
result = min(trunc(((sourceCurrent * rate) / 100)), targetMissing)
```

<a id="combat-convertresourcecost"></a>

### Resource consumed by conversion

Formula ID: `convertResourceCost`. Inputs, in order: `sourceCurrent`, `targetMissing`, `rate`.

```text
if (trunc(((sourceCurrent * rate) / 100)) <= targetMissing):
  result = sourceCurrent
else:
  result = trunc(((targetMissing * 100) / rate))
```

<a id="combat-secondaryattributedamage"></a>

### Additional HP, MP, or AP damage

Formula ID: `secondaryAttributeDamage`. Inputs, in order: `potentialDamage`, `rates`.

Sum AttributeDamageRate Value2 for the desired resource, excluding modifiers whose resource equals the primary ability Attribute. Use potential damage, not actual capped damage.

```text
result = trunc(((potentialDamage * sum(rates, for each rate: rate)) / 100))
```

<a id="combat-statusapplicationdamage"></a>

### Direct damage or healing when a status applies

Formula ID: `statusApplicationDamage`. Inputs, in order: `maximum`, `value`, `percentage`.

DamageRateOnApply uses the selected maximum directly. DamageOnApply uses the flat value. Neither runs through ordinary attack or periodic modifiers.

```text
if percentage:
  result = trunc(((maximum * value) / 100))
else:
  result = value
```

<a id="combat-stancerecovery"></a>

### Resource change on a stance change

Formula ID: `stanceRecovery`. Inputs, in order: `maximum`, `rate`.

```text
result = trunc(((maximum * (0 - rate)) / 100))
```

<a id="combat-threatgain"></a>

### Threat after gain modifiers

Formula ID: `threatGain`. Inputs, in order: `amount`, `userMultiplier`, `abilityAdditive`, `hasAbilityModifier`.

```text
if ((userMultiplier != 100) or hasAbilityModifier):
  result = max(0, trunc(((trunc(((amount * userMultiplier) / 100)) * (100 + abilityAdditive)) / 100)))
else:
  result = amount
```

<a id="combat-threatstatbonus"></a>

### Attribute scaling for flat ability threat

Formula ID: `threatStatBonus`. Inputs, in order: `amount`, `user`, `ability`.

```text
result = (amount + trunc(((user.Stats.Str * ability.StrRate) / 100)) + trunc(((user.Stats.Vit * ability.VitRate) / 100)) + trunc(((user.Stats.Dex * ability.DexRate) / 100)) + trunc(((user.Stats.Agi * ability.AgiRate) / 100)) + trunc(((user.Stats.Mnd * ability.MndRate) / 100)) + trunc(((user.Stats.Spi * ability.SpiRate) / 100)) + trunc(((user.Stats.Spd * ability.SpdRate) / 100)) + trunc(((user.Stats.Lck * ability.LckRate) / 100)))
```

<a id="combat-threatcurrentchange"></a>

### Requested change to existing threat

Formula ID: `threatCurrentChange`. Inputs, in order: `current`, `additiveRate`, `flat`.

```text
result = (trunc(((current * additiveRate) / 100)) + flat)
```

<a id="combat-threatdecay"></a>

### Threat after decay

Formula ID: `threatDecay`. Inputs, in order: `current`, `decayMultiplier`.

```text
result = trunc(((current * (100 - min(100, max(0, trunc(((20 * decayMultiplier) / 100)))))) / 100))
```

<a id="combat-threatmissinghp"></a>

### Threat generated from missing HP

Formula ID: `threatMissingHP`. Inputs, in order: `currentHP`, `maximumHP`.

```text
if (currentHP <= trunc((maximumHP / 2))):
  result = trunc(((maximumHP - currentHP) / 2))
else:
  result = 0
```

<a id="combat-threathealing"></a>

### Threat generated by healing a threatened ally

Formula ID: `threatHealing`. Inputs, in order: `healing`, `targetMaximumHP`, `targetThreat`.

Use the positive magnitude after threat-gain modifiers. Only alive, present monsters whose highest-threat target is the healed ally receive this threat.

```text
result = trunc(f32((f32(targetThreat) * min(1, max(0, f32((f32(healing) / f32(targetMaximumHP))))))))
```

<a id="combat-threatapply"></a>

### Threat after accumulated changes

Formula ID: `threatApply`. Inputs, in order: `current`, `deltas`.

Accumulate all deltas before clamping. Damage threat contributes the threat-gain-adjusted positive HP damage.

```text
result = max(0, (current + sum(deltas, for each delta: delta)))
```

<a id="combat-defensestatbonus"></a>

### Attribute-derived flat DEF or RES bonus

Formula ID: `defenseStatBonus`. Inputs, in order: `stat`.

The native flat bonuses are zero. Vitality and Spirit instead affect defense reduction.

```text
result = 0
```

<a id="combat-agilityratingbonus"></a>

### Attribute-derived accuracy or evasion

Formula ID: `agilityRatingBonus`. Inputs, in order: `agility`.

```text
result = agility
```

## Ordered character-sheet stages

Apply these after the source-group modifiers have been collected as specified in the package guide. Order is significant; later stages use updated values.

1. `STR = (stat.STR + if (context.unarmed and tag.StrBonusWhileUnarmed) then config.StrWhileUnarmedBonusFlat else 0)`
2. `HP = addPercent(stat.HP, percent.HP)`
3. `MP = addPercent(stat.MP, percent.MP)`
4. `STR = addPercent(stat.STR, percent.STR)`
5. `VIT = addPercent(stat.VIT, percent.VIT)`
6. `DEX = addPercent(stat.DEX, percent.DEX)`
7. `AGI = addPercent(stat.AGI, percent.AGI)`
8. `MND = addPercent(stat.MND, percent.MND)`
9. `SPI = addPercent(stat.SPI, percent.SPI)`
10. `SPD = addPercent(stat.SPD, percent.SPD)`
11. `LUK = addPercent(stat.LUK, percent.LUK)`
12. `AP = addPercent(stat.AP, percent.AP)`
13. `HP = multiplyPercent(stat.HP, (100 + hpMultiplier))`
14. `ATK = (stat.ATK + if (context.unarmed and tag.UnarmedPAtk) then unarmedAttack(stat.STR) else 0)`
15. `TT = (stat.TT + turnTime(stat.SPD, ttMultiplier))`
16. `CRIT = (stat.CRIT + critChance(if tag.CritFromMndAndSpi then (stat.MND + stat.SPI) else stat.DEX))`
17. `CRIT_DAMAGE = (stat.CRIT_DAMAGE + critDamage(if tag.CritFromMndAndSpi then (stat.MND + stat.SPI) else stat.DEX))`
18. `ACC = (stat.ACC + stat.AGI)`
19. `EVA = (stat.EVA + stat.AGI)`
20. `PPEN = (stat.PPEN + penetration(stat.STR))`
21. `MPEN = (stat.MPEN + penetration(stat.MND))`
22. `ATK = addPercent(stat.ATK, percent.ATK)`
23. `DEF = addPercent(stat.DEF, percent.DEF)`
24. `RES = addPercent(stat.RES, percent.RES)`
25. `ACC = addPercent(stat.ACC, percent.ACC)`
26. `EVA = addPercent(stat.EVA, percent.EVA)`
27. `PPEN = addPercent(stat.PPEN, percent.PPEN)`
28. `MPEN = addPercent(stat.MPEN, percent.MPEN)`
29. `MP = if tag.NoMP then 0 else stat.MP`
30. `DEF = if tag.PDefMax then max(9999, stat.DEF) else stat.DEF`
31. `RES = if tag.MDefMax then max(9999, stat.RES) else stat.RES`
32. `ATK = (stat.ATK + if (tag.TwoHanded and context.twoHanded) then twoHandedAttack(context.weaponAttack, config.TwoHandedPAtkFlat, config.TwoHandedPAtkRate) else 0)`
33. `ATK = if (tag.DualWield and context.dualWield) then multiplyPercent(stat.ATK, config.DualWieldPAtkRate) else stat.ATK`
34. `HP = max(1, min(9999, stat.HP))`
35. `MP = max(0, min(999, stat.MP))`
36. `STR = max(0, stat.STR)`
37. `VIT = max(0, stat.VIT)`
38. `DEX = max(0, stat.DEX)`
39. `AGI = max(0, stat.AGI)`
40. `MND = max(0, stat.MND)`
41. `SPI = max(0, stat.SPI)`
42. `SPD = max(0, stat.SPD)`
43. `LUK = max(0, stat.LUK)`
44. `AP = max(0, min(99, stat.AP))`
45. `ATK = max(0, stat.ATK)`
46. `DEF = max(0, stat.DEF)`
47. `RES = max(0, stat.RES)`
48. `CRIT = max(0, stat.CRIT)`
49. `CRIT_DAMAGE = max(0, stat.CRIT_DAMAGE)`
50. `ACC = max(0, stat.ACC)`
51. `EVA = max(0, stat.EVA)`
52. `PPEN = max(0, stat.PPEN)`
53. `MPEN = max(0, stat.MPEN)`
54. `TT = max(0, stat.TT)`

## Curve tables

Tables clamp outside their endpoints and use curveSegment between adjacent keys.

### hitCurve

| Input | Value |
| --- | --- |
| 0 | 0 |
| 0.25 | 0.2 |
| 0.5 | 0.5 |
| 0.75 | 0.8 |
| 0.875 | 0.9 |
| 1 | 0.95 |
| 1.25 | 0.98 |
| 1.5 | 1 |

### expLevelCurve

| Input | Value |
| --- | --- |
| -10 | 0 |
| -5 | 0.35 |
| 0 | 1 |
| 5 | 1.2 |
| 10 | 1.2 |

### jpLevelCurve

| Input | Value |
| --- | --- |
| -10 | 0.8 |
| -5 | 0.9 |
| 0 | 1 |
| 5 | 1.2 |
| 10 | 1.4 |

### cumulativeJPCurve

| Input | Value |
| --- | --- |
| 0 | 1.5 |
| 200 | 1.5 |
| 300 | 1.4 |
| 400 | 1.25 |
| 600 | 1.125 |
| 1000 | 1 |

### troopRewardCurve

| Input | Value |
| --- | --- |
| 1 | 1 |
| 2 | 0.95 |
| 3 | 0.9 |
| 4 | 0.85 |
| 6 | 0.8 |
| 8 | 0.75 |

### defeatLossCapCurve

| Input | Value |
| --- | --- |
| 1 | 0 |
| 9 | 0 |
| 10 | 1 |
| 11 | 2 |
| 12 | 3 |
| 13 | 5 |
| 14 | 7 |
| 15 | 9 |
| 20 | 20 |
| 25 | 50 |
| 30 | 200 |
| 36 | 1000 |
| 40 | 2000 |
| 50 | 5000 |
| 60 | 10000 |

## Machine operator reference

- `literals`: Number, boolean or null literals; a bare string is a dot-separated own-property variable path, never executable code
- `arithmetic`: add and mul fold left to right; sub/div/mod/pow are binary; min/max accept two or more arguments; division by zero and nonfinite results fail
- `integer`: trunc rounds toward zero; floor/ceil/abs have their mathematical meanings; i32 requires an integer in [-2147483648,2147483647], rejecting unsupported native overflow
- `f32`: Round to IEEE-754 binary32, ties to even, retaining its exact value as a number; fail on nonfinite output
- `logic`: eq/ne compare values; lt/lte/gt/gte compare numbers; not negates numeric/boolean truth; if(condition,yes,no), and, and or evaluate lazily
- `call`: call(name,...arguments) evaluates a named formula with positional inputs, requirements, sequential reassignable steps, and result in a fresh local scope
- `collections`: array(...expressions) constructs a list; length(list), at(list,integerIndex), and includes(list,value) do not coerce types; invalid indices fail
- `field`: field(record,name,fallback) reads an own property; fallback is evaluated only when record is null, not when a property is missing
- `find`: find(list,itemName,predicate) returns the first matching record or null in a lexical item scope
- `sum`: sum(list,itemName,expression) adds numeric per-item results in source order starting at 0
- `fold`: fold(list,itemName,accumulatorName,indexName,initial,expression) visits items in order with zero-based index and lexical accumulator; an empty list returns initial

This file is generated by `npm run calculations:reference`. Edit the authored rule definitions or reference renderer, then regenerate; `npm run calculations:check` rejects drift.
