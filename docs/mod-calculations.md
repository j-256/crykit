# Mod calculations and their boundaries

CryKit applies supported Crystal Edit data from the exact source revisions enabled in a Game Setup. Base data, the selected balance mode, and enabled mod layers supply inputs to the inspected Windows PC 1.6.9.0 formulas. Builds, character calculation plans, comparisons, and read-only shares use the pinned setup. Importing or browsing a source does not enable it.

## Editable data and engine rules

The inspected `SangMod` model and `SangDataManager.ApplyMod` define the Crystal Edit data boundary. `SangDataPatcher.InPlaceAssign` replaces matching numeric identities, while `InPlaceAssignment.Assign` limits localization changes to supported text fields. `ModCompiler` converts supported older editor formats and redirects added identities at game runtime. These are source-inspected PC behaviors; they do not establish another platform's loader or support executable patches.

| Area | Crystal Edit can change | CryKit calculation coverage |
| --- | --- | --- |
| Classes | Growth ratings, innate membership, abilities, learn trees, and equipment permissions | Numeric growth and supported primary/sub-command innates; learning and legality remain separate checks |
| Equipment and passives | Complete modifier lists, numeric values, modifier parameters, PP costs, types, handedness, and flags | Supported flat, percentage, per-level, and resting per-turn modifiers; paired equipment, unarmed effects, weapon bonuses, derived stats, and native caps |
| Genders | Names, appearance, and each `BoostHP` through `BoostLck` flag; additional records | Effective bonus profiles, including added identities, selected Total, contributions, and native base-growth previews |
| BattleConfig | The declared native configuration fields, including weapon and unarmed constants | Sheet constants feed the loadout; battle-only constants are retained and labeled outside the sheet calculation |
| Difficulties and enemies | Difficulty records, enemy inputs and behavior records | Separate enemy/difficulty previews; enemy multipliers do not change player stats |
| Abilities and statuses | Coefficients, costs, existing modifier tags and parameters, status records and references | Native coefficient-power and cost previews; contextual modifiers and status lifecycles require battle state |
| Formula implementation | No Crystal Edit record field replaces the executable's arithmetic | Native growth equations, bonus amounts, integer stages, rounding, modifier semantics, hit curve, and caps stay fixed |
| PP budget, equipment slots, and startup options | These are engine or startup behavior outside the supported record overrides | Existing saved assumptions remain explicit; a source record does not establish a different engine or startup setting |

Mods can select an existing modifier tag and change its parameters. Imported text, descriptions, and authored formulas remain inert. A mod that patches the executable or uses another loading framework is outside this calculation model, even if its displayed game version matches the PC baseline. See the [native package](calculations.md) for formula fingerprints and arithmetic scope.

## Gender bonus profiles

Choose **Calculation gender** in the loadout overview. Options use the effective gender record names and include additional imported profiles. A profile can remove the original HP bonus, enable Strength, or combine any supported flags. Each enabled flag uses the corresponding native bonus formula before equipment, modifiers, derived stats, rounding, and caps. Appearance does not select a bonus profile in CryKit.

The bundled Final Fantasy Project Overhaul source turns off the bonus flags on its Male and Female records. The bundled Crystal Project Remix source defines named Tough, Quick, Smart, and Lucky profiles with additional identities. Those are facts from the packaged revisions, not assertions about every release of either mod.

The Build's collapsed **Game Setup** summary names enabled source mods and distinguishes named-only settings. **Rules from game data** leads with the selected bonus profile and its source. **All bonus profiles** groups the effective flags by source; **Other rule changes** and **Difficulty and engine rules** provide further details. These disclosures start collapsed. An unspecified gender provides a no-bonus comparison baseline. The engine's `EnableGenderBoost` flag is an internal development control, not a player-facing option. Missing or invalid flags make that profile unresolved rather than treating absent flags as false. Neutral and other complete profiles can still be calculated. An unavailable saved profile stays saved and displays a recovery reason.

Rule changes use plain-language effect labels, descriptions, and value units. Their info icons reveal the exact technical field names on hover, keyboard focus, or tap; Escape dismisses the help. For example, **Learn free abilities from all classes** describes automatic learning of abilities costing zero JP, including abilities in classes the character has not unlocked, while excluding abilities locked by default. This rule does not establish a character's recorded learning. Loadout compatibility feedback covers equipment and passive-point checks, while stat views separately identify their resting calculation scope and coverage gaps.

Existing male/female inputs retain their meaning. Added selections use the optional versioned `genderSelection` input and resolve against the exact setup pins. Backups and shares preserve it; application versions without this field cannot import those records. Unknown selection versions and simultaneous legacy/additional selections fail validation before writes.

## Identity, order, and saved revisions

Native family and ID matches suggest replacement links when choosing a source revision. Names alone do not establish replacements. Explicit separate choices and reviewed links remain intact. Changed native innates resolve through the effective catalog even when their owning class is unchanged. Imported classes can use exact native innate records or definitions supplied by another enabled layer. Missing or invalid replacements do not silently restore vanilla effects. Preview abilities and retained status assumptions are rebound with the loadout when a setup changes.

Composition version 2 preserves this interpretation with each new configuration. Historical configurations without the marker retain their original catalog projection, so restoring an older backup does not rebuild it with different record kinds or reference mappings. New imports carry rule-projection version 2. Earlier rule projections remain readable; a historical import that archived gender changes requires reimporting and explicitly selecting the new revision. Original bytes, older catalog snapshots, observations, and checkpoint pins remain unchanged.

Planner priority is a user-selected ordering, not a discovery of the game's installed load order. The native loader remaps added identities by project. CryKit does not reproduce that runtime mapping. When different enabled projects reuse an added calculation identity, version 2 reports the collision and leaves combined totals unresolved. Matching original native identities can still use normal ordered overrides. Selecting one source or disabling the conflicting layer resolves the collision; importing another revision alone does not retarget a saved setup.

## Remaining calculation limits

CryKit calculates a resting sheet and specific native preview stages. Battle targeting, timing, active status lifecycles, accumulated turns, reactions, damage-context requirements, and random state are outside that sheet. Unsupported tags, incomplete numeric records, unsupported editor formats, unavailable sources, unknown personal inputs, and unsupported platform/version choices remain explicit coverage gaps. A mathematical total does not prove equipment legality, ownership, learning, or a complete encounter outcome.
