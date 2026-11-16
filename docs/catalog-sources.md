# Catalog sources

CryKit ships a static native reference catalog so a blank Playthrough can search Crystal Project definitions without importing a file or making a runtime network request. Definitions remain separate from inventory, character learning, party progress, and personal observations. Finding an entry never establishes ownership, learning, or availability in a particular save.

## Native launch baseline

The bundled vanilla catalog uses fingerprinted Crystal Project 1.7.0.1 databases and reviewed implementation evidence. Gameplay references use PC, covering Windows, macOS, and Linux; see [platform coverage](platform-coverage.md). Executable fingerprints, extraction provenance, and platform-specific behavior retain their platform labels. Nintendo Switch 1.6.6 uses the inspected PC console-branch proxy and the same definitions. Other Switch versions, randomizer changes, and mod configurations require separate evidence.

The prelaunch native-only baseline replaces the former mixed community catalog. Full wiki and modding-guide snapshots, redundant community definitions, the broad community artwork snapshot, and historical source-disagreement records are not packaged. Small attributed guidance supplements retain practical directions and route choices where they add useful information beyond the native records. Old prelaunch bundled-catalog references are not remapped to the new revision. Personal records are not deleted, and missing exact sources remain unresolved. An old backup containing its own source bodies retains those bodies through the ordinary import rules; their presence does not make them part of the bundled baseline.

Source identity, revision, and checksum remain exact. A changed bundled source requires a new revision. [`source-revisions.json`](../src/catalog/source-revisions.json) records packaged source receipts; a receipt cannot supply a missing definition. Saved workspaces and backups include the complete source bodies required by their dependencies. No latest-revision or name fallback is permitted.

## Game databases and implementation

[`native-game-data.json`](../src/catalog/native-game-data.json) contains the normalized native databases, executable version evidence, file hashes, numeric enums, and extraction provenance. It covers enemies and their actions, drops and steals, abilities, statuses, equipment, items, classes and learn trees, passives, recipes, biomes, encounters, difficulty, growth, and selected configuration. Vanilla and Chaos patches remain separate records until an explicit Game Setup selects their behavior.

Native record IDs establish identity. Repeated names, test records, dummy records, and mode variants remain distinct. A null database field is a known absent source value; it does not establish an unreviewed runtime default. Enum labels identify numeric values without proving the behavior of every modifier.

[`native-mechanics.json`](../src/catalog/native-mechanics.json) supplies standalone descriptions for reviewed implementation facts. Each description retains executable and source-file fingerprints and method locators. No community description is required as an underlying record. Calculations and native mechanic claims are not filled from a guide or guessed from a matching modifier name. A separate compact guidance file retains attributed descriptions where native rendering is incomplete, plus useful directions and class-master locations. It supplies explanatory text only and cannot change native records or calculation inputs.

The [calculation package](calculations.md) preserves native integer steps, rounding, modifier order, and explicit input requirements. Synthetic fixtures compare supported arithmetic with compiled unchanged native methods. Native source access does not establish a complete encounter simulation or platform parity beyond the verified scope.

Refresh an owned installation with:

```sh
npm run game-data:update -- --input <game-content-directory>
npm run game-data:check
npm run class-trees:update
npm run game-identities:update
npm run calculations:update
npm run mods:index:update
```

Inspect each command's help for exact inputs. The updater decodes containers and inspects executable metadata and enums without executing the game. Review source identity, version, modes, numeric identities, and normalized changes before committing a new catalog revision. Do not commit an installation, decompiled code, private export, or local filesystem paths. Ordinary builds and checks use only committed factual projections and Node dependencies.

## Native reference features

Native descriptions expand the game's vocabulary and supported display rules, including linked item abilities. Unsupported display rules remain explicit. Imported text and formulas are never executed. Equipment categories, flat stats, class permissions, costs, and learn trees resolve from their source records rather than inherited wiki fields.

[`world-acquisition-v1.json`](../src/catalog/world-acquisition-v1.json) and reviewed condition facts supply acquisition routes, including chest rewards, shops, crafting, drops, steals, and world interactions. Loot availability and per-attempt steal success stay separate. A missing supported route does not prove an item unobtainable. Gardening, encounter conditions, and reviewed shop prices retain their own fingerprinted evidence.

The [world map](../src/catalog/world-map.json) uses native placements and authored world records. Coordinates establish placements rather than player progress or route recommendations. Mod previews follow exact enabled source layers and retain unresolved references when a record is unavailable.

The Quintar guide retains a compact attributed route and practical capture directions, with every pairing checked against native breeding rules. Native rules supply pairing outcomes, race requirements, readiness, nursery capacity, food, and Incubator behavior. Route choices and landmark directions retain their supplemental attribution rather than being presented as native mechanics. Existing completed-step records are preserved without assigning them to a different recipe.

## Artwork

Native artwork uses explicit numeric database identities, texture paths, and crop regions. [`game-assets.json`](../src/catalog/game-assets.json) retains extraction evidence and coverage gaps; [`game-artwork.json`](../src/catalog/game-artwork.json) is its runtime projection. Local content-addressed PNGs are emitted with the application and prepared for offline use. No game installation, wiki, or CDN is contacted at runtime.

Class standing frames, creature images, equipment and status images, currency, mastery seals, and reviewed menu glyphs use exact native bindings. A small menu-icon supplement preserves familiar glyphs without a verified native equivalent. Its manifest retains the original file metadata, byte hashes, and source rights. Native glyphs take precedence, and unsupported keys remain readable text. A definition without artwork has an explicit placeholder. Names alone do not assign an image. Native artwork belongs to the game's rights holders and receives no application license grant.

Refresh and check artwork with:

```sh
npm run game-assets:update -- --input <game-content-directory>
npm run game-assets:check
```

Private imported mod artwork retains exact source ownership. [`mod-artwork.json`](../src/catalog/mod-artwork.json) and its runtime projection record source-specific bindings and gaps. Mod replacements do not silently inherit artwork from the replaced base record. An unverified image or missing texture remains unavailable. Runtime atlas checks compare crops pixel-for-pixel with the original factual snapshot.

## Mod imports and attribution

The launch collection contains no bundled mod definitions or full mod files. Private Crystal Edit imports remain supported and retain their exact source revision, editor format, unknown fields, and project identity. Mod catalog browsing does not enable a mod. See [Crystal Edit imports](crystal-edit.md) and [Mod Inspector](mod-inspector.md).

Imported sources keep their own rights and attribution. A source or artwork match does not establish platform compatibility or a redistribution grant. The application's AGPL-3.0-only license applies to original application code; source-specific game data, artwork, fonts, and dependencies retain their separate rights.

## Verification

```sh
npm run sources:check
npm run certainty:check
npm run mods:index:check
```

The [source audit](source-audit.json) verifies that the packaged collection contains only native source claims, exact native mechanic definitions, and a canonical catalog checksum. The [certainty report](catalog-certainty.json) records source states and supported presentation gaps. Complete publication verification follows [development guidance](development.md#publication-verification); focused checks alone do not establish compatibility across consumers.
