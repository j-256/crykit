# Crystal Edit data and growth estimates

The application ships a normalized vanilla class baseline from the class-copy export dated 2026-09-27, made with Crystal Edit editor version 34. The maintainer identifies these as copies of the vanilla classes and assumes they match the game release available on that export date. The editor version is recorded separately from the game version, which was not supplied. No user import is required to use this baseline. Updating the baseline for a later game release is an authoring operation that requires a new immutable catalog revision.

The bundled facts include numeric growth ratings, equipment categories, class selection flags, command and crystal labels, ability and passive ID membership, learn-tree coordinates, and prerequisite connectors. The copies have new job IDs; those export-local IDs are retained as provenance and do not replace the established vanilla class identities. Existing wiki facts and saved catalog references remain available in their original revisions. Mods can edit vanilla classes but cannot delete them, so the vanilla baseline does not establish the effective values of a modded class.

The source export contains references to abilities and passives without their definitions. These are displayed as numbered unresolved entries. Their names, learning costs, PP costs, and effects are not supplied by this file. The exported tree is independent of the Switch screenshot maps, which can contain additional learnable innate nodes. Neither source establishes a character's learned state.

Equipment enum meanings and the column-first tree format are documented in the [CrystalProjector job schema](https://github.com/iconmaster5326/CrystalProjector/blob/main/schema/json/job.yaml). Gate cells and prerequisite directions are retained. Empty arrays differ from omitted fields; explicit zero ratings remain zero.

## Bundled mod evidence

The bundled Equipment Expansion snapshot comes from a versioned Crystal Edit project export. It supplies exact equipment, ability, status, recipe, item, and monster records. Equipment details include type, handedness, capacity, price, level, texture reference, and every original StatMod value. Modifier names follow Crystal Edit's enum. Direct flat and additive stat modifiers participate in build estimates; conditional, per-level, per-turn, status, reaction, damage, cost, and other complex modifiers remain listed as excluded effects unless the planner has a separately verified rule. The [equipment schema](https://github.com/iconmaster5326/CrystalProjector/blob/main/schema/json/equipment.yaml) documents texture and equipment fields, while the community modding guide describes modifier behavior.

The supplied custom texture sheets and the base game's `Content/Textures/Equipment.dat` archive are normalized into exact 34-pixel cells using Crystal Edit's seven-column indexing. Custom texture references resolve against the mod folder; reused base-game references resolve against the named, length-prefixed PNG entries in the local archive. The bundled cells remain copyrighted third-party artwork and are not covered by this project's license.

Learnable Innate Skills evidence comes from a version 1.0 export dated 2023-06-04. It records each learnable innate's class, tree position, PP cost, and JP unlock cost. That export may be older than the Workshop or Nintendo Switch version. Its values are displayed under fields labeled `Learnable Innate Skill v1.0`; uniform JP values are historical evidence, not confirmation of current unlock costs. Newer in-game Switch PP and availability observations retain precedence when they overlap, and the dated class placements do not replace the vanilla class baseline or confirmed Switch skill maps. The [passive schema](https://github.com/iconmaster5326/CrystalProjector/blob/main/schema/json/passive.yaml) documents the PP and learnable flags. Neither source establishes that a character has learned an innate.

Maintainers can regenerate these normalized files without committing private source paths:

```sh
npm run mods:update -- --equipment-json PATH --equipment-assets DIR --base-equipment-archive PATH --learnable-innates-json PATH
npm run mods:check
```

The check mode validates committed records, source digests, exact sprite hashes, image dimensions, and the absence of private machine paths without requiring the original project files.

The earlier `wiki-v1` and `bundled-v1` catalog revisions remain bundled with their original content and checksums. Existing Game Setups, builds, observations, and backups retain their exact pins; adding the mod evidence does not silently retarget saved records to `bundled-v2`. Default Reference browsing uses the current revision, while exact historical links remain available.

## Importing custom classes and class edits

Open **Data & settings > Import & backup**, choose a Crystal Edit project JSON file such as `mod.json`, and review the preview. **Add references** adds the catalog to the shared reference library without replacing Playthroughs, Builds, or Game Setups. Repeating the same import leaves the planner-data revision unchanged. The addition can be undone, and complete backups retain the catalog and original source bytes.

Jobs are normalized into class facts. Included abilities, passives, equipment, items, monsters, statuses, recipes, and biomes become searchable reference records with their source fields preserved. Other project data stays in the archived source. Imported descriptions and formulas are inert data. A malformed model or repeated ID within a model family rejects the import before writes. Storage failure rolls back the entire addition and leaves the preview available for retry.

The project ID provides the catalog namespace, the file digest identifies its immutable revision, and model family plus ID identifies each record. Job IDs in the documented vanilla range are labeled as edits to vanilla classes; higher IDs are labeled as custom classes. Names do not determine whether a class is an edit. Controlled exports show complete records for the selected edited classes, including unchanged values and full membership lists and trees. Each imported record is a snapshot, not a field patch or an additive membership list. Other vanilla classes can be absent from a mod export without being deleted. Missing fields stay unknown in the companion; they are not filled from similarly named classes. Imports retain separate source catalog identities and do not activate mods by themselves. Enable imported revisions under Game Setup to compose their effective definitions. Without a saved layer configuration, imported definitions remain available for explicit selection. Saved Game Setup revisions retain their exact catalog pins.

## Configuring imported mod layers

Open **Data & settings > Game Setup > Imported mod layers** after importing the files. Add each project, choose its exact revision, and enable or disable it. **Earlier** and **Later** arrange planner priority; the last enabled layer wins when records share the same model family and native ID. Confirm this chosen priority against the order used by the game. The companion does not inspect the game installation or assert its runtime loading behavior.

Layers replace complete records. They do not merge membership lists or fill omitted fields from a lower layer. An explicit empty list replaces the previous list, zero remains zero, and an absent field stays unknown. Records absent from a mod remain available from the baseline or an earlier enabled layer. Different model families remain distinct even when their numeric IDs match. Definitions referenced by a class can come from any enabled layer; references absent from the complete enabled set remain unresolved.

Expand **Review effective records and replacement links** to inspect each winning source, its superseded entries, and its original source record. Use **Bundled target** to explicitly link a native model to a bundled definition of the same kind. A linked replacement retains the bundled logical identity, preserving stock and learning associations while applying the new definition values. Names and copied export-local IDs do not establish this link. An unlinked record stays separate and displays its unresolved target; **Keep as a separate definition** records that choice. Two distinct native identities cannot silently replace the same bundled target.

Saving a changed composition creates an immutable effective catalog and a new Game Setup revision. Other Game Setup edits reuse the existing effective catalog, preserving exact personal override pins. Planning pickers and default reference browsing use the pinned effective definitions, while exact links to source and historical revisions remain available. Earlier builds, snapshots, and Game Setups keep their pinned values. Updating an import, changing priority, disabling a layer, or revising a link requires saving a new Game Setup revision. One project revision can be chosen in a layer configuration; importing another revision does not automatically select it.

Personal overrides based on an earlier catalog require review when layers change. **Use layer definitions for these records** removes those override pins from the new Game Setup so its layered definitions apply. The personal definitions and older Game Setups remain intact; they are not silently retargeted to new source values.

The effective catalog stores changed records and an exact baseline pin, expanding unchanged entries locally when loaded. Native backups retain the baseline, selected source revisions, original bytes, layer order, enabled states, replacement links, and effective revisions. Restoration validates the effective result against its sources. A failed save rolls back both the configuration and its derived catalog; the retained draft supports retry, and undo restores the earlier configuration.

Supported exported fields supply class ratings, equipment permissions and occupancy, native passive PP costs, and the existing scoped planning calculations. Global project settings, unmapped numeric modifier tags, and unsupported battle behavior remain archived data. Set the shared passive PP budget explicitly under **Advanced Game Setup** when a mod changes it. Enabling a layer does not execute formulas, establish platform parity, grant ownership, or record learning.

## Growth calculator

Open a class with exported ratings in **Reference**, then expand **Growth calculator**. Enter the character level and allocate its growth levels across classes. **Use this class for all growth levels** is an explicit hypothetical allocation, not a claim about a character's history. Changing one growth class changes only that row. Clear or incomplete allocations produce unknown results rather than silently assuming the primary class's history. Imported classes work in the same calculator when their required ratings are present.

The equations come from GEEF's Crystal Project modding guide, **Game synopsis > Growths**. They combine the primary class rating, level, and weighted growth history, with different coefficients for HP, MP, and the core stats. Optional stat bonuses apply the guide's gender-bonus equations only to explicitly selected stats. Appearance does not select them. Expand **Formula breakdown and scope** to see base, level, growth, and bonus contributions.

Results are estimates of unequipped base stats. Calculations retain fractions; display formatting shows up to three decimal places without asserting the game's integer rounding. Equipment, passives, statuses, and other mod effects are excluded. Estimates are never written into observed character stats. The calculator does not require a complete game database.

The build editor extends this with [equipment checks and saved calculation plans](planner-mechanics.md), supported equipment/passive/status contributions, derived stats, and scoped ability previews. The reference-page calculator remains focused on unequipped class growth.

## Guide reference

The guide's stat and ability modifier glossaries are bundled as searchable **Mechanics** entries with section and line locators. Repeated names with differing descriptions retain conflicting source claims, including the two descriptions of `KillsUser`. These entries describe community research and do not automatically become executable validation rules.

The reference entry **Growth estimates and damage formula research** records unresolved damage details. The guide reverses variance and critical-hit order between its prose and its final pipeline, and its defense denominator differs from the [developer's published explanation](https://steamcommunity.com/app/1637730/discussions/0/676199918678875437/). These local uncertainties limit damage simulation; they do not prevent using independently supported class data or growth estimates.

The original guide, embedded images, original class-copy project, and original mod project exports are not committed. Bundled normalized facts and glossary text retain their source attribution. Their content rights are separate from the application's code license; no redistribution license is established by possession of a source file. Custom project archives stay in local browser storage and backups. The application makes no runtime game-data requests.
