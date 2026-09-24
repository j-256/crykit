# Local data and interchange

Crystal Companion separates reference definitions, personal observations, and hypothetical plans. Importing reference material does not establish current stock or character learning. Original source bytes and unmapped fields are retained for inspection and native backup.

## Supported inputs

| Input | Recognition | Applied data |
| --- | --- | --- |
| Reference workbook | OOXML `.xlsx` with supported named tables | Reference definitions and claims, explicitly supported party progress, and historical acquisition observations |
| Research JSON | Root `schema_version` equal to `1.1.0` | Supported reference arrays and explicit personal mappings; unsupported sections remain source evidence |
| Research package | Bounded ZIP with one unambiguous supported research JSON payload | The same adapter as research JSON, retaining the original package |
| Native backup | ZIP containing `manifest.json`, `bundle.json`, and declared source files | Complete supported profile state, referenced catalog revisions, evidence, and retained history |

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

The manifest uses `format: "crystal-companion-backup"` and `formatVersion: "1.0.0"`. It names `bundle.json` and lists each retained source file's identity, filename, format, size, and SHA-256 digest. `bundle.json` contains the profile, lineage, immutable catalog snapshots, evidence, and retained history. Source files occupy declared `sources/*.bin` entries.

The manifest reports how many undo checkpoints were available to the export and how many fit. If complete history would exceed the bounded payload, export keeps the newest checkpoints and marks history as truncated; preview reports that limitation. If no checkpoint fits, the exported command journal is cleared so a restored profile does not offer an unavailable Undo action. The complete current facts, required catalogs and evidence, and every referenced source file remain in the backup. Raw rows are retained in evidence alongside the original source bytes, while catalog legacy data contains only unnormalized package metadata so backups do not duplicate every row several times.

The ZIP file is not encrypted. It may contain personal notes and original source files. Export time records when the application assembled the download; it does not prove that the browser saved the file or that a second device restored it. Keep independent backups and periodically test a restore into a separate profile.

Unsupported future versions, malformed nested records, broken references, conflicting immutable revisions, corrupt sources, unsafe archive paths, duplicate entries, and excessive expansion are rejected. Limits are defined alongside the parser rather than inferred from a filename. The exporter checks that its output fits the supported container and JSON bounds.

## Storage and recovery

IndexedDB is scoped to the application's origin, including scheme, hostname, and port. Changing the hosting origin opens another database. Persistent-storage permission can reduce eviction risk, but browser storage is not a substitute for an exported file.

Every profile write supplies the revision it was based on. The comparison and write occur in one transaction. A stale tab cannot overwrite a newer saved profile. A failed write keeps the open draft available for a recovery export; that draft is distinct from the last committed database revision.

The service worker stores only the static application shell. Its cache does not contain imported source files or personal records, and changing the shell does not migrate or erase profile data. Offline readiness is checked against the complete built asset list.
