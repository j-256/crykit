# Crystal Edit data and growth estimates

The application ships a normalized vanilla class baseline from the class-copy export dated 2026-09-27, made with Crystal Edit editor version 34. The maintainer identifies these as copies of the vanilla classes and assumes they match the game release available on that export date. The editor version is recorded separately from the game version, which was not supplied. No user import is required to use this baseline. Updating the baseline for a later game release is an authoring operation that requires a new immutable catalog revision.

The bundled facts include numeric growth ratings, equipment categories, class selection flags, command and crystal labels, ability and passive ID membership, learn-tree coordinates, and prerequisite connectors. The copies have new job IDs; those export-local IDs are retained as provenance and do not replace the established vanilla class identities. Existing wiki facts and saved catalog references remain available in their original revisions. Mods can edit vanilla classes but cannot delete them, so the vanilla baseline does not establish the effective values of a modded class.

The source export contains references to abilities and passives without their definitions. These are displayed as numbered unresolved entries. Their names, learning costs, PP costs, and effects are not supplied by this file. The exported tree is independent of the Switch screenshot maps, which can contain additional learnable innate nodes. Neither source establishes a character's learned state.

Equipment enum meanings and the column-first tree format are documented in the [CrystalProjector job schema](https://github.com/iconmaster5326/CrystalProjector/blob/main/schema/json/job.yaml). Gate cells and prerequisite directions are retained. Empty arrays differ from omitted fields; explicit zero ratings remain zero.

## Importing custom classes and class edits

Open **Data & settings > Import & backup**, choose a Crystal Edit project JSON file such as `mod.json`, and review the preview. **Add references** adds the catalog to the active profile without replacing its inventory, characters, learning, builds, or rulesets. Repeating the same import leaves the profile revision unchanged. The addition can be undone, and complete backups retain the catalog and original source bytes.

Jobs are normalized into class facts. Included abilities, passives, equipment, items, monsters, statuses, recipes, and biomes become searchable reference records with their source fields preserved. Other project data stays in the archived source. Imported descriptions and formulas are inert data. A malformed model or repeated ID within a model family rejects the import before writes. Storage failure rolls back the entire addition and leaves the preview available for retry.

The project ID provides the catalog namespace, the file digest identifies its immutable revision, and model family plus ID identifies each record. Job IDs in the documented vanilla range are labeled as edits to vanilla classes; higher IDs are labeled as custom classes. Names do not determine whether a class is an edit. Controlled exports show complete records for the selected edited classes, including unchanged values and full membership lists and trees. Each imported record is a snapshot, not a field patch or an additive membership list. Other vanilla classes can be absent from a mod export without being deleted. Missing fields stay unknown in the companion; they are not filled from similarly named classes. Imports retain separate catalog identities and do not automatically activate mods or overwrite the shipped baseline. Choose the imported definition explicitly when modeling its values. Saved rulesets retain their catalog pins.

## Growth calculator

Open a class with exported ratings in **Reference**, then expand **Growth calculator**. Enter the character level and allocate its growth levels across classes. **Use this class for all growth levels** is an explicit hypothetical allocation, not a claim about a character's history. Changing one growth class changes only that row. Clear or incomplete allocations produce unknown results rather than silently assuming the primary class's history. Imported classes work in the same calculator when their required ratings are present.

The equations come from GEEF's Crystal Project modding guide, **Game synopsis > Growths**. They combine the primary class rating, level, and weighted growth history, with different coefficients for HP, MP, and the core stats. Optional stat bonuses apply the guide's gender-bonus equations only to explicitly selected stats. Appearance does not select them. Expand **Formula breakdown and scope** to see base, level, growth, and bonus contributions.

Results are estimates of unequipped base stats. Calculations retain fractions; display formatting shows up to three decimal places without asserting the game's integer rounding. Equipment, passives, statuses, and other mod effects are excluded. Estimates are never written into observed character stats. The calculator does not require a complete game database.

The build editor extends this with [equipment checks and saved calculation plans](planner-mechanics.md), supported equipment/passive/status contributions, derived stats, and scoped ability previews. The reference-page calculator remains focused on unequipped class growth.

## Guide reference

The guide's stat and ability modifier glossaries are bundled as searchable **Mechanics** entries with section and line locators. Repeated names with differing descriptions retain conflicting source claims, including the two descriptions of `KillsUser`. These entries describe community research and do not automatically become executable validation rules.

The reference entry **Growth estimates and damage formula research** records unresolved damage details. The guide reverses variance and critical-hit order between its prose and its final pipeline, and its defense denominator differs from the [developer's published explanation](https://steamcommunity.com/app/1637730/discussions/0/676199918678875437/). These local uncertainties limit damage simulation; they do not prevent using independently supported class data or growth estimates.

The original guide, embedded images, and original class-copy project are not committed. Bundled normalized facts and glossary text retain their source attribution. Their content rights are separate from the application's code license; no redistribution license is established by possession of a source file. Custom project archives stay in local browser storage and backups. The application makes no runtime game-data requests.
