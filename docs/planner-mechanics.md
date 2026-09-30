# Build mechanics and estimates

The Build editor applies supported rules from GEEF's Crystal Project modding guide to the selected source definitions. These checks work on unowned equipment and unlearned passives. Scenario validation separately checks recorded stock, learning, passive PP limits, class unlocks, and Game Setup applicability. Saving a plan never changes observed character stats, inventory, or learning.

## Equipment checks

Exported primary-class equipment categories provide permissions. The sub-command does not supply its class's equipment list. Supported permission descriptions such as Equip Sword and Equip All add categories. Explicit innate descriptions supply Dual Wield and Two-Handed; Shapeshift can inherit a documented sub-command innate. Custom Crystal Edit classes use their own exported fields and native passive references. A saved imported-layer configuration resolves those native references across its enabled layers through the effective catalog. Similarly named vanilla records do not establish missing identities.

Equipment categories map to main hand, off hand, head, body, and accessory roles. The suggested layout has these roles; custom layouts can assign them under **Data & settings > Game Setup**. Accepted definition types use a finite multi-select rather than comma-separated identifiers. Historical suggested slots retain their established roles. Explicit custom slot and requirement rules remain available to scenario validation.

A two-handed weapon reserves both hands even when selected in one hand with the other empty. If the same copy is displayed in both hand slots, use **Same copy as**; its stats and stock demand count once. Separate weapons require Dual Wield. A one-handed weapon can share both hand slots when Two-Handed is present. Known unique-equipment flags, duplicate passive selections, disabled class selections, and wrong equipment roles produce conflicts. Missing hand counts and unknown permission effects produce unresolved findings where they matter. Plans can still be saved with conflicts.

## Passive PP budget

Passives are stored as an ordered, variable-length list, not as Game Setup slots. Each passive contributes its documented PP cost to one total. The unmodified game permits up to 10 PP across all equipped passives, so new Game Setups default to that limit and modded Game Setups can override it. PP is a Game Setup limit rather than a character observation. Unknown costs keep the total unresolved, and a known nonnegative subtotal over the limit proves the Build invalid even when another selected cost is unknown.

The Crystal Edit [equipment schema](https://github.com/iconmaster5326/CrystalProjector/blob/main/schema/json/equipment.yaml) identifies equipment type, two-handed occupancy, and unique-equipment fields. The [passive schema](https://github.com/iconmaster5326/CrystalProjector/blob/main/schema/json/passive.yaml) identifies PP and innate/learnable flags. The companion reads those properties from retained source records without changing old catalog snapshots.

## Saved calculation inputs

Expand **Stats & combat estimates** to enter a planned level, explicit growth allocations, optional per-stat bonuses, active statuses, a preview ability, and target evasion. **Use primary class for all growth** makes a deliberate hypothetical allocation. Clearing a growth class or leaving allocations incomplete keeps the affected estimates unknown.

Inputs belong to the immutable build checkpoint. Cloning, comparison, backup restore, and offline reload preserve them. Growth classes, statuses, and abilities obey the checkpoint's catalog lock. Comparisons show inputs by name, supported stat estimates, exclusions, and calculation notes. Old checkpoints without calculation inputs remain valid.

## Included calculations

Base growth uses the [class growth equations](crystal-edit.md#growth-calculator). The evaluator adds explicit numeric equipment fields and narrowly recognized flat or percentage descriptions for HP, MP, core stats, Attack, Defense, Resistance, crit chance/damage, accuracy/evasion, and penetration. Repeated descriptions of the same contribution count once. Disagreeing source values leave that stat unresolved. Crit and penetration percentages are percentage points; HP/MP and core-stat percentages are additive percentage modifiers.

The derived estimates cover crit chance, extra critical damage, accuracy, evasion, physical/magical penetration, and turn time. Dual Wield uses the selected description's Attack reduction when both weapon hand counts are known. Two-Handed uses the selected description's flat bonus only for a one-handed weapon explicitly shared between hand slots. Unarmed Attack remains unresolved without its battle settings.

The guide does not specify flat-versus-percentage ordering for every stat. Mixed contributions therefore display the two candidate orderings. These are scenario estimates, not guaranteed bounds on the game result. Fractional values are retained until display; game rounding and caps are not asserted. Turn-time estimates stop above the documented formula's speed turning point.

Ability previews read only supported numeric coefficients and costs. Wiki coefficient patterns allow numeric constants, recognized stat names, addition, and multiplication; unknown tokens remain inert and unresolved. Native ability previews use the guide's named coefficient fields, including explicit null fallback behavior. Source code, functions, and arbitrary expressions are never evaluated. HP costs are percentages of maximum HP; MP/AP costs are flat; CT adds delay. Native JP costs display both the rounded-down LP label and the whole LP needed. See the [ability field schema](https://github.com/iconmaster5326/CrystalProjector/blob/main/schema/json/ability.yaml).

Physical hit chance uses the guide's supplied accuracy/evasion steps. Unspecified intervals and zero target evasion remain unknown. Ability-specific accuracy, guaranteed hits/misses, and other overrides are outside this base preview.

## Remaining limits

The contribution list and exclusion list describe the scope of each estimate. Unknown numeric Crystal Edit StatMod tags, conditional triggers, reactions, status timing, damage multipliers, cost modifiers, and custom battle settings require more source data or verified rules. Selecting an active status preserves that assumption but does not simulate its lifecycle. Selecting an ability does not establish that the character has learned it or that the build can use it.

Final enemy damage is not predicted: the guide and a developer explanation disagree on defense reduction, and the class exports do not include enemy definitions. Full enemy behavior, drops, encounters, project configuration, and mod-specific effects need their corresponding data. These gaps do not block the supported equipment checks, growth calculations, or coefficient previews.

The separate [PC steal mechanics research](steal-mechanics.md) records the executable's availability, success, Luck, failure-protection, multi-entry display, and guaranteed-attempt mod formulas. It is source evidence for the inspected PC build rather than a calculation performed by Crystal Companion, and it does not establish Nintendo Switch parity.
