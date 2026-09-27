# Local data and interchange

Crystal Companion separates reference definitions, personal observations, and hypothetical plans. Importing reference material does not establish current stock or character learning. Original source bytes and unmapped fields are retained for inspection and native backup.

## Starter catalog and personal overrides

When browser storage contains no profiles, initialization creates a labeled sample playthrough with character observations, stocked equipment, build checkpoints, and an active team. Sample records carry synthetic provenance and use the bundled catalog's exact references. They are written atomically and are not recreated on reload. Explicitly created blank profiles and imported profiles are not seeded. Native backups preserve sample records like other local records, without an imported source archive or an initial undo checkpoint.

The built-in [public names catalog](catalog-sources.md) is installed locally for every profile without creating personal records or undo entries. No runtime request is needed. Reference imports add separate immutable catalogs; equal names across sources do not automatically merge. A backup includes the starter revision when personal records or retained history reference it, without inventing an imported source file.

Creating or saving a ruleset in Data & settings includes the built-in catalog in the new revision's lock when it is not already pinned. Existing catalog pins remain unchanged. For an older ruleset that lacks this catalog, save a new ruleset revision before selecting its definitions in a build.

Creating a definition adds a profile-owned record. Editing a definition creates another immutable personal record with an exact `baseRef` and, for a personal revision, `previousRevision`. The original catalog or personal definition remains available. Preferred revisions are suggested by ordinary pickers, while existing build checkpoints and observations keep their exact references. Stock, learning, and progress use the lineage's logical identity so an edit does not create another owned copy or erase learning.

Reference can collect selected preferred personal definitions into an immutable ruleset revision. Its `definitionOverrides` field pins exact personal references and its catalog lock includes required source revisions. Collecting replaces selected logical roots in the source layer and retains its other pins. This is an explicit reviewed collection: it does not rewrite selections, substitute new mechanics into historical builds, or activate the resulting ruleset. Original sources and all referenced personal revisions remain in native backups. Older backups without override metadata remain supported; malformed or branched lineage is rejected.

## Supported inputs

| Input | Recognition | Applied data |
| --- | --- | --- |
| Reference workbook | OOXML `.xlsx` with supported named tables | Reference definitions and claims, explicitly supported party progress, and historical acquisition observations |
| Research JSON | Root `schema_version` equal to `1.1.0` | Supported reference arrays and explicit personal mappings; unsupported sections remain source evidence |
| Research package | Bounded ZIP with one unambiguous supported research JSON payload | The same adapter as research JSON, retaining the original package |
| Native backup | ZIP containing `manifest.json`, `bundle.json`, and declared source files | Complete supported profile state, referenced catalog revisions, evidence, and retained history |
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

Restore defaults to an independent profile when the same profile identity exists. Replacement is explicit and checks the target revision inside the write transaction. Automatic profile merging is not supported: snapshot counts are never summed, and divergent records are not silently selected by timestamp.

## Native backup structure

Character snapshots can carry `rulesetRevisionId`, pinning their recorded slot labels and order independently of the active ruleset. A supplied pin must reference a retained ruleset. Legacy snapshots without this field remain importable; their stored slot IDs are displayed without borrowing active labels. New captures pin the capture ruleset, and recording a build as current pins that build revision's ruleset. Capturing under a changed or previously unrecorded slot context requires selections to be recorded again. Backups retain these pins and all earlier snapshots.

The manifest uses `format: "crystal-companion-backup"` and `formatVersion: "1.0.0"`. It names `bundle.json` and lists each retained source file's identity, filename, format, size, and SHA-256 digest. `bundle.json` contains the profile, lineage, immutable catalog snapshots, evidence, and retained history. Source files occupy declared `sources/*.bin` entries.

The manifest reports how many undo checkpoints were available to the export and how many fit. If complete history would exceed the bounded payload, export keeps the newest checkpoints and marks history as truncated; preview reports that limitation. If no checkpoint fits, the exported command journal is cleared so a restored profile does not offer an unavailable Undo action. The complete current facts, required catalogs and evidence, and every referenced source file remain in the backup. Raw rows are retained in evidence alongside the original source bytes, while catalog legacy data contains only unnormalized package metadata so backups do not duplicate every row several times.

The ZIP file is not encrypted. It may contain personal notes and original source files. Export time records when the application assembled the download; it does not prove that the browser saved the file or that a second device restored it. Keep independent backups and periodically test a restore into a separate profile.

Unsupported future versions, malformed nested records, broken references, conflicting immutable revisions, corrupt sources, unsafe archive paths, duplicate entries, and excessive expansion are rejected. Limits are defined alongside the parser rather than inferred from a filename. The exporter checks that its output fits the supported container and JSON bounds.

## Storage and recovery

IndexedDB is scoped to the application's origin, including scheme, hostname, and port. Changing the hosting origin opens another database. Persistent-storage permission can reduce eviction risk, but browser storage is not a substitute for an exported file.

Every profile write supplies the revision it was based on. The comparison and write occur in one transaction. A stale tab cannot overwrite a newer saved profile. A failed write keeps the open draft available for a recovery export; that draft is distinct from the last committed database revision.

The service worker stores only the static application shell. Its cache does not contain imported source files or personal records, and changing the shell does not migrate or erase profile data. Offline readiness is checked against the complete built asset list.

## Reference correction deltas

The versioned `crystal-companion-corrections` JSON format transfers immutable correction decisions independently of personal records. Full native backups can also include the global correction registry; its restoration is an explicit import option and commits atomically with the profile. See [correction editing, provenance, and baseline promotion](corrections.md) for the contribution workflow and source-review boundaries.
