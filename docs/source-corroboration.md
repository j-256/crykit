# Game-code corroboration

The source audit inventories citations in repository text, normalized data, artwork manifests, and every immutable bundled catalog revision. [The inventory](source-audit.json) records where each citation appears, its disposition, field assessment outcomes, and reasons for retaining evidence. Fixture-only URLs and generated audit outputs are excluded. A retained citation means the complete claim has no reviewed proof from the inspected reference; it does not mean the claim is false.

[Code evidence](../src/catalog/game-code-evidence.json) pins the Windows executable and system database by SHA-256. It records relative decompiled file names, file hashes, member or modifier locators, reviewed descriptions, and partial-match qualifications. [Field receipts](../src/catalog/source-corroboration.json) bind corroboration to catalog identity, revision, checksum, entity, and field. Database locators identify the exact numeric record; file hashes are in the native gameplay snapshot. Generated game code, private paths, and installation bytes are excluded.

The interface removes **Sources** and **Supplemental source** disclosures only from unchanged known facts supported by receipts or their direct versioned native or bundled mod provenance. The original catalog fields, source references, checksums, conflicting claims, backups, and pinned plans remain unchanged. **Source trail** and **Source and version details** retain original attribution and applicability. Changed local corrections, personal versions, arbitrary imports, unknowns, and conflicts retain their evidence. Matching a modifier name is partial evidence and does not corroborate a complete description.

Class pages show one named learn tree in **Class growth and learning**. Their native identity, related definitions, and **Complete native source record** belong in **Source and version details** below the gameplay sections. The complete record displays bounded raw JSON, preserving its original `LearnTree` values without another skill-tree presentation. Personal class versions use the same arrangement.

## Supported claims and retained boundaries

Reviewed numeric identity links support matching equipment prices, handedness, uniqueness, levels, ordinary flat stat contributions, resource and learning costs, PP costs, class commands, equipment permissions, growth ratings, and exact matching class-copy fields. Every conversion requires complete value agreement. Equal display names do not establish identity. Mode overrides and dated mod exports retain their distinct scope.

Simple modifier descriptions have receipts only where both the implementation and its consumer support the complete description. Other guide entries retain their citations and candidate code locators. The audit records parameter-order differences in `Flat AbilityAPCost` and `AttributeDamageRate`, percentage-offset ambiguity in several multipliers, and the nonlinear `StealChanceUp` calculation. Repeated `KillsUser` descriptions remain conflicting claims.

Growth coefficients agree with `Calculator.CalculateMemberHP`, `CalculateMemberMP`, and `CalculateMemberStat`. The Windows engine uses integer intermediate divisions and final `Math.Round`; the companion's fraction-preserving estimates omit those operations. Optional gender bonuses also depend on the engine's `EnableGenderBoost` flag. Coefficient agreement does not corroborate an exact final stat estimate or every mod configuration.

Quintar pairing results, nursery capacity, and distinct-track win counting are supported by `CQuest` and `QuestStateData`. The Windows type labels come from `system.dat` vocabulary: Yellow is Desert, Green is Highland, Teal is River, and White is Aqua. Windows 1.6.9 requires one partner win for Desert and Highland, two for River, three for Black, and four for Aqua. The community guide uses two for Desert and Highland, so its race recommendations retain their source and version caveat. Capture geography, shop acquisition, route selection, and publisher packaging require separate evidence.

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

The [certainty audit](catalog-certainty.json) checks the bundled baseline against its source receipts. Reviewed numeric identity bindings connect base and mod definitions to their exact source records; source-prefixed entity aliases and development revision adapters are not retained. Known nulls represent absent source values, and inapplicable planning fields do not become uncertainty warnings. Full export records, version evidence, and source hashes remain available in Source and version details.
