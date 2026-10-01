# Mod Inspector

Open **Tools > Mod Inspector** to read an external Crystal Edit mod JSON and understand its records, identifiers, and relationships. Editing and exporting a copy are optional. The **JSON document** tab contains the file picker and document tools. The **Enum dictionary** tab is a shared reference available without opening a file. Search by a numeric value or its exact internal name, such as `RevealStatsAuto`. Switching tabs preserves pending edits and dictionary searches. Use Left/Right Arrow, Home, or End to switch tabs from the keyboard.

## Import and inspect

Choose **Open JSON file** to inspect a Crystal Edit file. **Files opened in this tool** lists local browser copies using the mod's declared title and version when available, alongside the filename. The selected file summary distinguishes the original from an edited copy and shows its project ID when provided. Missing or invalid metadata does not prevent inspection, and matching titles, project IDs, or filenames do not merge independent files.

The imported original stays intact while edits are saved separately. Opening or editing a file here does not add it to the planner or change Game Setups, builds, or playthroughs. To use an exported file for planning, add it through **Data & settings > Import & backup**, then choose its revision in Game Setup. The planner groups revisions by the mod's project ID; importing another revision does not duplicate builds or automatically change their saved definitions.

Expand the JSON tree and select a field to inspect its value. Known enum values display their internal names. Known references resolve within the appropriate record family, using the imported mod's definition before the bundled base definition. Duplicate identities remain ambiguous. Missing references, unsupported fields, and unfamiliar enum values remain visible.

Use **Expand branch** or **Collapse branch** for the selected container. Selecting a scalar targets its parent container. Alt-click an expander to open or close that branch and its descendants. Other branches keep their state. Expanded content appears in bounded pages; use the continuation controls to reveal more rows. These controls only change the inspector view and do not edit the mod.

Parameter meanings depend on the surrounding effect. `StatMods[].Tag` and ability-effect tags belong to separate enums. A `Value1` field can contain a quantity, an enum value, or a reference to another record. The inspector supplies picklists only where the reference schema establishes the field's meaning. Restrictions describe source-backed types and selectors; they do not establish that a combination will behave as intended in the game.

The reference identifies its game and editor version. Older and newer mod formats are preserved without an automatic upgrade. The bundled reference does not establish equivalence across game versions or platforms. Base records unavailable in the bundled snapshot remain unresolved unless the imported mod defines them.

World entities have a bundled reference from the main world loaded by Crystal Edit. Entity summaries show their type, stored name or key when available, biome, and coordinates. Selecting an entity's `ID` exposes a searchable list of base and mod-local identities; names, IDs, and location details are searchable. Choosing another ID changes only that value, leaving the entity's other fields as written. Mod-local definitions take precedence over matching base IDs, and duplicate mod identities remain ambiguous.

The entity reference contains identifying metadata and related catalog IDs, without event scripts or dialogue. Its IDs are scoped to `field.dat`, the editor's main world. Arena entities reuse some of those numbers and are excluded. An unresolved ID stays unknown; missing fields in a mod-local entity are not filled from the base reference.

Choose **Find relationships** for a selected field or record. Incoming links cover database records, the editor's Tree, and entity records whose relationships you have inspected. Uninspected world-entity actions are excluded from the incoming index. The issue list reports this coverage limit. Searching and inspecting fields discovers issues; the issue list is not a complete game compatibility check.

## Editor format and navigation metadata

`EditorVersion` is a format and migration marker, separate from the mod's `Version` and the game's release version. The pinned Crystal Edit writes format `34`; the pinned Windows game flags higher markers as incompatible and applies version-dependent conversions to older data. A missing marker defaults to `0` in those readers. Matching the lookup format does not establish that every field or mod combination is compatible.

CryKit preserves the imported marker and does not run Crystal Edit's conversions. Changing the integer alone does not upgrade or downgrade the data and can skip conversions the loader expects. The **Editor format** disclosure identifies matching, older, newer, missing, and invalid markers. Export review calls out marker edits, including edits made through a containing JSON object. Preserve the marker unless the document's data has been deliberately converted for the target format.

`Tree` is Crystal Edit's saved navigation hierarchy. Its entries refer to records stored elsewhere, and the hierarchy can include unchanged base records and folders. Its presence does not mean those records have gameplay changes. The pinned game's runtime mod model does not read `Tree` or `Folders`.

Each navigation entry combines `ModelTypeID`, an entry in the editor's model registry, with a `ModelID` in that model family. CryKit shows the resolved name, model type, and ID, using mod-local records before bundled references. A node can link directly to its mod-local definition. Repeated folder names do not identify the same folder; unknown and ambiguous references stay visible.

`Children` contains nested navigation entries. `SortOrder` is sibling ordering metadata used by the editor's add and move operations; CryKit shows the stored array order. `IsExpanded` is the saved expansion state in Crystal Edit. Expanding a branch in CryKit does not change that field.

## Edit and export

Use a field's JSON editor or searchable picklist to change its value, then apply the edit. Objects and arrays can be edited as JSON to add or remove fields and records. Invalid JSON remains in the editor for correction; applying it does not replace the saved draft. Large numbers and unknown properties retain their original representations when untouched.

Review the export before downloading it. The review compares the working draft with the imported original, grouping changes by record and distinguishing additions, removals, field edits, and identifiable record moves. In arrays with unique IDs, inserting or removing a record does not mark later records as moved; movement identifies changed relative order among surviving records. Formatting and object-key order do not count as semantic changes. Downloads contain ordinary mod JSON without inspector annotations. Exporting does not replace the original baseline.

The original can be downloaded separately. Test edited mods with the intended game version before relying on their behavior.

## Browser storage and recovery

Originals and working drafts are saved in this browser and origin. Keep exported copies outside the browser. Inspector drafts are stored separately from planner data and are not included in the planner's backup ZIP.

**Remove from recent files** removes the browser copy and its stored original after confirmation. Download any copies you want to retain first. **Label reference** shows the source of displayed names and links, with lookup history when a browser copy was first opened using different reference data. A reference change does not establish that the mod is outdated and does not produce a compatibility notice. The stored reference identifier and document text are preserved; **Editor format** describes the mod's own format marker separately.

If a save fails, keep the page open and retry or export the working text. A stale tab cannot silently overwrite a newer saved revision. Finish or discard open edits before switching drafts or leaving the inspector. Clearing browser storage removes the saved originals and drafts.

Large documents use collapsed branches and paged results. Recursive expansion retains bounded rendering so a whole document can be opened without mounting every row at once. Offline use follows CryKit's normal **Data & settings > Offline & storage** preparation workflow. No imported mod content is uploaded.

Imports must be valid UTF-8 JSON with an object at the root. Duplicate object keys are rejected because they make editing ambiguous. The importer preserves an optional UTF-8 byte-order marker, line endings, and numeric text. Resource limits are 96 MiB per imported file, three million JSON values, and a nesting depth of 128. A file that exceeds a limit is rejected before it replaces any saved draft.

## Reference maintenance

[The editor schema snapshot](../src/mod-inspector/reference-schema.json) records enum names, declared model fields, discriminators, and selector bindings extracted from Crystal Edit. Its source metadata pins the Windows game and editor executables by SHA-256. [The native game snapshot](catalog-sources.md) supplies bundled base record names and game enum values. Supplemental animation and voxel IDs and names come from the matching installed databases. Folder IDs and names come from the editor's folder reference and describe editor organization only. [The entity reference](../src/mod-inspector/entity-reference.json) identifies the main world's entity records, with source fingerprints for the world, biome database, and matching executables. Each supplemental source retains its own fingerprint and scope; empty slots are not invented records. The inspector adds no runtime dependency on a game installation.

Refresh entity metadata with `npm run entity-reference:update -- --input "/path/to/Crystal Project"`. Generation requires .NET 10 and a matching owned installation. The exporter checks the world against the reviewed fingerprint in the editor schema, invokes the installed game's binary entity reader from a temporary assembly copy, verifies entity stream boundaries and the world's ID/coordinate ledger, and writes only the metadata projection. It leaves installed files untouched. Review a changed world before updating that source pin. `npm run entity-reference:check` verifies the committed reference offline using Node, including its digest and source pins. This check is included in `npm run check`.

To refresh the editor schema, compare the matching editor's model enum declarations and property types, stat and ability parameter selector bindings, monster action-condition selectors, and model registration. Update the factual schema and source fingerprints together. Preserve unknowns where those sources do not establish a mapping or restriction. Recompute `contentDigest` as SHA-256 of compact JSON with recursively sorted object keys and unchanged array order, excluding the root `contentDigest` field. The reference tests verify this digest, contextual lookup, full bundled enum coverage, mod precedence, ambiguous identities, and relationship scope. Personal mod files and decompiled source do not belong in the repository.

Inspector storage keeps metadata and bounded text chunks in separate IndexedDB stores to support large originals and drafts without oversized records. Database layout version 2 migrates the earlier inline-text layout transactionally while retaining the logical draft schema and source pin. Import, save, and removal commit all affected stores together. Storage tests cover incomplete chunks, concurrent revisions, failed writes, and migration rollback.

File summaries use a versioned optional display cache so the recent file list does not read document payloads. Older entries acquire their title and version when opened. Cache updates preserve document text, source pins, timestamps, and edit revisions; failure to cache a label does not prevent reading a file. Display labels are bounded and do not establish identity or deduplication.
