# Calculation package

Crystal Companion's numeric character calculations use versioned JSON rules and data. The package is available from **Export calculation package** on the character and Build calculation panels, or without a game installation:

```sh
npm run calculations:export -- --output calculations.json
npm run calculations:check
```

Running `node scripts/export-calculations.mjs` without an output option writes JSON to stdout. The export contains no saves, character observations, inventory, personal definitions, installation paths, or credentials. It can be consumed offline in another language or application. It contains factual numeric projections and arithmetic rules, not the game's executable, textures, descriptions, or decompiled source files. These projections do not grant rights to the original game assets.

## Contents and evidence

The `crystal-project-calculations` format has `schemaVersion: 1`. Its `id` identifies the verified rules, `pc-1.6.9-v1`. The [JSON Schema](../src/calculations/package-v1.schema.json) describes its structure. Exported sections are:

| Section | Purpose |
| --- | --- |
| `rules` | Formulas, integer steps, rounding, caps, ordered sheet stages, modifier tags and scopes, gender identities, benchmark assumptions, and coverage |
| `data` | Job ratings and innate IDs, equipment and passive modifiers, gender bonuses, ability coefficients and costs, status modifiers, balance patches, and battle configuration |
| `legacy` | The separate community guide model retained for older saved plans, including its fractional estimates and incomplete hit-chance curve |
| `verification` | Synthetic input/output vectors from compiled, unchanged methods extracted from the inspected executable, with evidence describing the probe |

The [PC rules](../src/calculations/pc-1.6.9-v1.json) identify the inspected executable by SHA-256 and name the relevant methods. [Numeric data](../src/catalog/native-stats-v1.json) is a generated projection of the [shared native game snapshot](../src/catalog/native-game-data.json), which supplies the catalog's base facts. Routine checks regenerate the projection in memory and reject drift from that shared source. The export records its source digest, database hashes, identity sources, and a checksum. Native catalog records carry explicit identities; older catalog bindings attach IDs to native database IDs with evidence. The pinned crosswalk establishes existing item and job identities. Additional passive bindings require the wiki's explicit owning class, membership in that native job's passive list, a normalized label, and the exact innate flag. Starter aliases follow the catalog's existing kind-and-label wiki merge. Foreign catalogs and similarly named personal definitions do not inherit these bindings.

The original installation supplied PC 1.6.9.0. This does not establish Nintendo Switch, randomized, or modded parity. Imported Crystal Edit numeric records can supply their own ratings and modifiers; unavailable innate references and unsupported numeric effects remain unresolved. The Standard, Vanilla, and Chaos selections apply the corresponding inspected database patches. They do not infer additional runtime configuration.

## Arithmetic format

An expression is a numeric literal, a variable-name string, or an array whose first entry names an operation. For example:

```json
["trunc", ["div", ["add", ["mul", "rating", "level"], "growth"], 2]]
```

This is the integer growth seed `(rating * level + growth) / 2`. A formula declares ordered `inputs`, optional named `steps`, and a `result`. `call` supplies arguments in the called formula's declared input order. Each step can use earlier variables and replaces its own named variable when applicable. `sheetStages` run in order against `stat.*`, `percent.*`, `tag.*`, `context.*`, and `config.*` variables. Every numeric sheet formula and its ordering live in the rules data; the evaluator supplies arithmetic primitives and resolves records and loadout context.

| Operation | Behavior |
| --- | --- |
| `add`, `mul` | Fold at least two arguments from left to right |
| `sub`, `div`, `pow` | Two arguments; division by zero and nonfinite results are errors |
| `min`, `max` | At least two arguments |
| `trunc` | One argument, truncated toward zero |
| `roundEven` | One argument, rounded to nearest integer with midpoint ties to even, matching `Math.Round` |
| `floor`, `ceil` | One argument; used by legacy LP previews |
| `lte` | Two arguments; returns numeric 1 or 0 |
| `eq` | Two arguments; returns numeric 1 for equality or 0 otherwise |
| `and` | Two arguments; returns 1 or 0 with short-circuit evaluation |
| `if` | Condition, true expression, false expression; evaluates only the selected branch |
| `call` | A formula name followed by its arguments |

Use IEEE-754 doubles and preserve the expression's operation order. Integer divisions appear explicitly as `trunc(div(...))`; do not combine or move rounding steps. Native integer products are verified over ordinary character and game-data inputs, not arbitrary values that overflow the game's signed integer arithmetic. Missing variables, invalid operations, nonfinite values, division by zero, and evaluation-budget exhaustion produce unresolved calculations. Depth and operation limits are part of the rules. The [reference evaluator](../src/domain/calculation-rules.ts) uses a finite operator list; it does not use `eval`, `Function`, or imported code. Crystal Companion evaluates only its bundled arithmetic data and never executes imported descriptions or formula packages.

## Sheet inputs and order

Growth history sums each allocated class rating multiplied by its assigned levels. Allocations must total the player level, including level 1. The equipped primary class also supplies the current job rating. Gender bonuses apply before base-stat rounding. Neutral, male, and female totals each run through the complete sheet pipeline, so their differences include rounding and derived effects on accuracy, evasion, penetration, critical values, and turn time.

Equipment and passives accumulate flat and additive percentage modifiers in their own groups. Per-level modifiers truncate before accumulation. Resting per-turn modifiers use zero turns. Turn-time multipliers truncate within each group and when combining groups. Primary-class innates apply automatically; the explicit sub-job innate effect adds the selected secondary class's innates. Paired-equipment bonuses follow the inspected same-ID hand and accessory checks. A physical copy shared between hand slots counts once.

The ordered stages apply unarmed Strength, core percentage bonuses, HP multiplication, unarmed Attack, derived bonuses, equipment-stat percentages, special overrides, Two-Handed and Dual Wield, and final caps. DEF and RES come from equipment and modifiers; VIT and SPI additionally matter in defense reduction. Crit bonus damage is the extra percentage on a critical hit. AP is maximum capacity, not the character's accumulated battle AP.

Unknown equipment observations, unknown passive lists, unmapped selected definitions or equipment roles, incomplete growth, unsupported numeric tags, and automatic status effects keep totals unresolved. Base growth remains visible when known. Equipment legality and learning remain separate checks; a mathematical loadout total does not establish that a character can equip or use it.

## Damage scope

The physical benchmark uses base power 0, Attack rate 100, and Strength rate 100. The magical benchmark uses base power 100, Attack rate 0, and Mind rate 100. Both use a synthetic target with DEF/RES 100 and VIT/SPI 100. They preserve native integer steps and the inspected single-defense reduction formula. They show the consequences of stat changes without simulating an encounter.

Damage multipliers, elements, critical outcomes, variance, reactions, target selection, status timing, HP-dependent defenses, and ability-specific modifiers require battle context and are excluded. Benchmark values are before those effects. Ability and status records in the export provide base data for further work; their presence does not mean every battle calculation is implemented. [Steal mechanics](steal-mechanics.md) remain separate source research.

## Compatibility and maintenance

New Build plans default to level 60, Standard PC rules, and all growth in the primary class. Untouched growth follows primary-class and calculation-level changes. Editing a class allocation, amount, or row switches to manual mode. Manual allocations survive class and level changes, including an over-budget level decrease, until the user corrects them. **Follow primary class for all growth** explicitly restores automatic tracking. Sliders retain the full level scale and clamp increases to the shared remaining allowance.

Character calculation assumptions are saved in new immutable snapshots alongside unchanged observations. Calculation level does not rewrite recorded level, and calculated totals never replace recorded totals. Build checkpoints, cloning, comparison, backups, and offline use preserve the model and growth mode. Older plans without a model retain the guide calculator and manual allocation semantics; **Use verified PC calculations** explicitly changes that choice. A plan without calculation inputs stays valid. Numerical behavior changes require a new model ID rather than changing the meaning of persisted plans.

To reproduce the numeric projection offline from the shared native snapshot:

```sh
npm run calculations:update
```

The updater verifies the source executable identity and modifier enum labels, projects the reviewed fields, and writes atomically. Optionally pass `--input "$CRYSTAL_PROJECT_INSTALL_DIR"` to verify the installed executable and database hashes against the bundled source. Updating the shared snapshot follows the [native catalog workflow](catalog-sources.md). A different executable requires a new calculation version rather than overwriting this dataset. Routine checks need no private inputs or network requests. The parity vectors cover growth, gender rounding, crit curves, penetration, speed bounds, turn multipliers, and isolated defense benchmarks. Domain tests additionally exercise modifier order, growth allocation intent, identity boundaries, shared equipment, persistence, and rollback.
