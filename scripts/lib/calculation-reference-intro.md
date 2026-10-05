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
