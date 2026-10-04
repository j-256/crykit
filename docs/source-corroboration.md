# Game-code corroboration

The source audit inventories citations in repository text, normalized data, artwork manifests, and every immutable bundled catalog revision. [The inventory](source-audit.json) records where each citation appears, its disposition, field assessment outcomes, and reasons for retaining evidence. Fixture-only URLs and generated audit outputs are excluded. Citations preserve attribution as well as unresolved evidence boundaries. Retaining a citation does not mean a claim is false or that native evidence is unavailable.

[Code evidence](../src/catalog/game-code-evidence.json) pins the Windows executable and system database by SHA-256. It records relative decompiled file names, file hashes, member or modifier locators, reviewed descriptions, and partial-match qualifications. [Field receipts](../src/catalog/source-corroboration.json) bind corroboration to catalog identity, revision, checksum, entity, and field. Database locators identify the exact numeric record; file hashes are in the native gameplay snapshot. Generated game code, private paths, and installation bytes are excluded.

Verified native facts appear without routine citation markers. Reviewed receipts can also suppress redundant citations for unchanged base-game fields. Bundled mods, imported records, and community guidance remain external sources with **Sources** icons; a bundled mod export does not become base-game evidence. Native description, acquisition, and relationship projections have separate fingerprinted evidence, described in [native reference projections](native-reference-facts.md). The original catalog fields, source references, checksums, conflicting claims, backups, and pinned plans remain unchanged. Popups retain applicable attribution, original claims, and source disagreements. Matching a modifier name is partial evidence and does not corroborate a complete description.

Class pages show one named learn tree in **Class growth and learning**. Classes with unresolved facts can expose their native identity, related definitions, and **Complete native source record** in the **Sources** popup. That record displays bounded raw JSON, preserving its original `LearnTree` values without another skill-tree presentation. Verified native classes omit routine proof disclosures; their complete records remain preserved in the catalog. Retained personal class versions use the same uncertainty-dependent presentation.

## Supported claims and retained boundaries

Reviewed numeric identity links support matching equipment prices, handedness, uniqueness, levels, ordinary flat stat contributions, resource and learning costs, PP costs, class commands, equipment permissions, growth ratings, and exact matching class-copy fields. Every conversion requires complete value agreement. Equal display names do not establish identity. Mode overrides and dated mod exports retain their distinct scope.

Simple modifier descriptions have receipts only where both the implementation and its consumer support the complete description. Other guide entries retain their citations and candidate code locators. The audit records parameter-order differences in `Flat AbilityAPCost` and `AttributeDamageRate`, percentage-offset ambiguity in several multipliers, and the nonlinear `StealChanceUp` calculation. Repeated `KillsUser` descriptions remain conflicting claims.

Growth coefficients agree with `Calculator.CalculateMemberHP`, `CalculateMemberMP`, and `CalculateMemberStat`. The corroboration record distinguishes that coefficient agreement from exact results: the historical community-guide estimates omitted native integer intermediates and final `Math.Round`. The application's [native calculation model](calculations.md) preserves those steps and is checked against compiled-native numerical fixtures. Gender bonuses apply in normal gameplay; the engine's `EnableGenderBoost` flag is an internal development control rather than a player-facing setting. Neither coefficient agreement nor the native PC model establishes every mod configuration or platform's behavior.

Quintar pairing outcomes, readiness, feeding, nursery capacity, and distinct-track first-place counting are supported by `CQuest` and `QuestStateData`; the hatching and mating windows establish Incubator consumption and the empty-slot requirement. [`quintar-native-evidence.json`](../src/catalog/quintar-native-evidence.json) pins the executable, system database, and reviewed source-file hashes separately from immutable catalog claims. Windows type labels come from `system.dat` vocabulary: Yellow is Desert, Green is Highland, Teal is River, and White is Aqua. Windows PC 1.6.9 requires one partner win for Desert and Highland, two for River, three for Black, four for Aqua, and five for Gold. The planner uses these minimums and checks the route's pairing outcomes against native rules. Its Ocarina price uses the native acquisition projection. The chosen route, capture landmarks, and keep/release recommendations remain attributed guidance; Switch and mod applicability remain unverified.

Community prose, world routes, optimization advice, Nintendo packaging and version parity, dated mod revisions, manual observations, artwork rights, licensing, and external-tool or service documentation cannot be established by the inspected Windows code alone. Their citations remain. Gameplay agreement never replaces wiki attribution, asset credit, or source-specific rights.

## Reproduce the audit

With ordinary project dependencies installed, generate or verify the audit offline:

```sh
npm run sources:audit
npm run sources:check
```

To recheck the private immutable reference and its recorded installation, supply its snapshot directory:

```sh
npm run sources:check -- --reference <reference-snapshot-directory>
```

Reference verification compares executable, system data, inspected database, and decompiled file hashes with the reviewed evidence. A different build requires a new evidence review. Regeneration inventories changed citations and recalculates supported field comparisons; it does not promote unreviewed mechanic descriptions. `npm run check` verifies the generated audit without requiring an owned game installation or a decompiler.

The [certainty audit](catalog-certainty.json) checks the bundled baseline against its source receipts. Reviewed numeric identity bindings connect base and mod definitions to their exact source records; source-prefixed entity aliases and development revision adapters are not retained. Known nulls represent absent source values, and inapplicable planning fields do not become uncertainty warnings. Full export records, version evidence, and source hashes remain in the immutable catalog and committed source manifests. Sources popups expose the evidence relevant to external claims and unresolved values.
