# Native source verification

The packaged definition collection contains the native vanilla catalog and standalone reviewed mechanics. Selected supplemental descriptions and directions remain separately attributed and do not override native facts. [`source-audit.json`](source-audit.json) records its exact source IDs, revision, canonical checksum, definition coverage, and native executable/database fingerprints. Private imported sources retain their own attribution and are outside this packaged-source audit.

[`native-game-data.json`](../src/catalog/native-game-data.json) preserves extracted database contents and original source evidence. [`native-mechanics.json`](../src/catalog/native-mechanics.json) preserves reviewed source-file hashes and method locators. Native descriptions, calculations, world placements, acquisition conditions, artwork, and Quintar rules retain their own evidence manifests. Generated game code and installation bytes are not included.

Routine native facts do not need visible citation markers. Exact record comparisons prevent changed imports or personal definitions from inheriting verification merely because a name or numeric ID matches. Uncertain values and external sources remain inspectable. Native evidence establishes only the recorded platform/version/configuration scope.

Run the audit offline with:

```sh
npm run sources:audit
npm run sources:check
```

The audit rejects a secondary packaged catalog, non-native source claims, changed standalone mechanics, and checksum mismatches. Native refresh commands separately verify the owned source inputs when they are supplied. Ordinary checks do not require a game installation or decompiler.

The [certainty report](catalog-certainty.json) distinguishes absent source values and unsupported presentation from personal observations and unrecorded choices. Complete description rendering does not establish a complete battle simulator or an optimal route through the game.
