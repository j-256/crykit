# Local data and interchange

Crystal Kit separates reference definitions, personal observations, and hypothetical plans. Importing reference material does not establish current stock or character learning. Original source bytes and unmapped fields are retained for inspection and native backup.

[Mod Inspector](mod-inspector.md) keeps its imported originals and working drafts in a separate browser database. Download those files from the inspector; planner backups and restores do not include or replace them.

Quintar breeding guide marks are optional timestamped observations in each Playthrough's `quintarBreeding` record, keyed by the guide's fixed step identities. An absent key means no completion was recorded. Native backups preserve these marks and their undo history; unknown step identities and invalid timestamps are rejected. Completing a guide action does not establish current nursery contents or item possession.

## Starter catalog and personal overrides

When browser storage contains no planner data, initialization creates one local data root with a labeled sample Playthrough, character observations, stocked equipment, shared Build checkpoints, an active team, and a versioned Game Setup. Sample records carry synthetic provenance and use the bundled catalog's exact references. They are written atomically and are not recreated on reload. Explicitly created blank Playthroughs are not seeded with tracked records, but they can use the same shared Builds and Game Setups. Native backups preserve sample records like other local records, without an imported source archive or an initial undo checkpoint.

The built-in [native gameplay catalog](catalog-sources.md) is installed locally without creating personal records or undo entries. No runtime request is needed. Reference imports add separate immutable catalogs; equal names across sources do not automatically merge. A backup includes the starter revision when personal records or retained history reference it, without inventing an imported source file.

Creating or saving a Game Setup in Data & settings includes the built-in catalog in the new revision's lock when it is not already pinned. Existing catalog pins remain unchanged. A Build belongs to one logical Game Setup, and each Build checkpoint pins an exact Game Setup revision and catalog lock.

Creating a definition adds a locally owned record. Editing a personal definition or choosing **Create personal version** creates another immutable personal record with an exact `baseRef` and, for a personal revision, `previousRevision`. The original catalog or personal definition remains available. Preferred revisions are suggested by ordinary pickers, while existing Build checkpoints and observations keep their exact references. Stock, learning, and progress use the lineage's logical identity so an edit does not create another owned copy or erase learning.

Reference can collect selected preferred personal definitions into an immutable Game Setup revision. Its `definitionOverrides` field pins exact personal references and its catalog lock includes required source revisions. Collecting replaces selected logical roots in the source layer and retains its other pins. This is an explicit reviewed collection: it does not rewrite selections, substitute new mechanics into historical Builds, or make the resulting revision current. Original sources and all referenced personal revisions remain in native backups; malformed or branched lineage is rejected.

## Supported inputs

| Input | Recognition | Applied data |
| --- | --- | --- |
| Reference workbook | OOXML `.xlsx` with supported named tables | Reference definitions and claims, explicitly supported party progress, and historical acquisition observations |
| Research JSON | Root `schema_version` equal to `1.1.0` | Supported reference arrays and explicit personal mappings; unsupported sections remain source evidence |
| Research package | Bounded ZIP with one unambiguous supported research JSON payload | The same adapter as research JSON, retaining the original package |
| Native backup | ZIP containing `manifest.json`, `bundle.json`, and declared source files | Complete planner data, referenced catalog revisions, evidence, and retained history |
| Skill screenshots | Full PNG or JPEG Learn-menu images selected from Characters | Reviewed character-specific square observations and mapped learning; see [screenshot learning](screenshot-learning.md) |

The workbook adapter is for the documented reference-table layout, not arbitrary spreadsheets. Empty template rows do not become characters, possessions, or loadouts. Formula text is inert; a cached spreadsheet value does not establish a verified game rule. Research arrays without an explicit mapper remain available as source evidence instead of being guessed into personal state.

Supported research reference arrays include `classes`, `abilities`, `innates`, `passives`, `monster_magic`, `base_equipment`, `expansion_items`, and `recipes`. Supplemental arrays preserve source claims and context. A minimal synthetic input is:

```json
{
  "schema_version": "1.1.0",
  "base_equipment": [
    {
      "id": "example:reed-staff",
      "name": "Reed Staff",
      "description": "A fictional item used to demonstrate the import shape"
    }
  ]
}
```

Display names are labels, not stable identifiers. Keep source IDs when revising a reference pack. A definition's source claims and applicability remain distinct from whether a player owns, learned, or can use it.

Research packages may declare `catalog_id` or `source_namespace` to preserve one catalog identity across reviewed revisions. Without either field, the importer assigns a digest-scoped catalog identity. This keeps unrelated packs separate and means that automatic cross-revision identity requires an explicit namespace.

## Preview and restore

Parsing, archive checks, and schema validation finish before an import transaction begins. The preview identifies the detected format, record groups, warnings, and destination. Canceling the preview leaves stored records unchanged. Reimporting identical source content is idempotent.

Native restore replaces the one local planner-data root only after explicit confirmation. Replacement checks the target revision inside the write transaction and leaves existing data intact if validation or writing fails. Automatic merging is not supported: snapshot counts are never summed, and divergent records are not silently selected by timestamp. Create and switch Playthroughs for separate save lineages within that root.

## Native backup structure

Native backups allow a bounded 128 MiB uncompressed entry and 256 MiB aggregate output so native facts and earlier pinned catalog revisions can travel together. The selected file limit remains 32 MiB compressed, and other import formats retain their smaller extraction limits. Native backup payloads allow four million JSON nodes; other JSON imports retain the two million node limit. The depth limit, CRC, path, inflation-ratio, and schema checks still apply.

Character snapshots carry `gameSetupRevisionId`, pinning their recorded equipment-slot labels, order, and configuration independently of the Playthrough's current Game Setup. A supplied pin must reference a retained Game Setup revision. Snapshots store equipment by slot ID and passives as a separate ordered list with explicit knowledge state. New captures pin the capture Game Setup revision, and recording a Build as current pins that Build checkpoint's Game Setup revision. Capturing under a changed or previously unrecorded slot context requires selections to be recorded again. Backups retain these pins and all earlier snapshots.

The manifest uses `format: "crykit-backup"` and `formatVersion: "2.0.0"`. It names `bundle.json` and lists each retained source file's identity, filename, format, size, and SHA-256 digest. `bundle.json` contains the local planner data, lineage, immutable catalog snapshots, evidence, and retained history. Source files occupy declared `sources/*.bin` entries.

The manifest reports how many undo checkpoints were available to the export and how many fit. If complete history would exceed the bounded payload, export keeps the newest checkpoints and marks history as truncated; preview reports that limitation. If no checkpoint fits, the exported command journal is cleared so restored planner data does not offer an unavailable Undo action. The complete current facts, required catalogs and evidence, and every referenced source file remain in the backup. Raw rows are retained in evidence alongside the original source bytes, while catalog legacy data contains only unnormalized package metadata so backups do not duplicate every row several times.

The ZIP file is not encrypted. It may contain personal notes and original source files. Export time records when the application assembled the download; it does not prove that the browser saved the file or that a second device restored it. Keep independent backups and periodically test a restore in a separate browser environment.

Unsupported future versions, malformed nested records, broken references, conflicting immutable revisions, corrupt sources, unsafe archive paths, duplicate entries, and excessive expansion are rejected. Limits are defined alongside the parser rather than inferred from a filename. The exporter checks that its output fits the supported container and JSON bounds.

## Storage and recovery

IndexedDB is scoped to the application's origin, including scheme, hostname, and port. Changing the hosting origin opens another database. Persistent-storage permission can reduce eviction risk, but browser storage is not a substitute for an exported file.

Every planner-data write supplies the revision it was based on. The comparison and write occur in one transaction. A stale tab cannot overwrite newer saved planner data. A failed write keeps the open draft available for a recovery export; that draft is distinct from the last committed database revision.

The service worker stores only the static application shell. Its cache does not contain imported source files or personal records, and changing the shell does not migrate or erase planner data. Offline readiness is checked against the complete built asset list.

## Reference correction deltas

The versioned `crykit-corrections` JSON format transfers immutable correction decisions independently of personal records. Full native backups can also include the global correction registry; its restoration is an explicit import option and commits atomically with planner-data replacement. See [correction editing, provenance, and baseline promotion](corrections.md) for the contribution workflow and source-review boundaries.
