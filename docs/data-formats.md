# Local data and interchange

Crystal Kit separates reference definitions, personal observations, and hypothetical plans. Importing reference material does not establish current stock or character learning. Original source bytes and unmapped fields are retained for inspection and native backup.

[Complete workspace backups](workspace-backups.md) include saved Editor originals, working drafts, Save documents, and retained file history. Native planner ZIP backups and restores retain their planner-only scope. Individual file downloads remain available in [Mod Inspector](mod-inspector.md).

Quintar breeding guide marks are optional timestamped observations in each Playthrough's `quintarBreeding` record, keyed by the guide's fixed step identities. An absent key means no completion was recorded. Native backups preserve these marks and their undo history; unknown step identities and invalid timestamps are rejected. Completing a guide action does not establish current nursery contents or item possession.

## Catalogs and personal definitions

A fresh local workspace contains a labeled synthetic sample Playthrough, character observations, stocked equipment, starting Builds matching those observations, an active party plan, and a versioned Game Setup. Samples use exact launch source references and carry synthetic provenance. They are written atomically, are not recreated on reload, and create no initial undo checkpoint. Explicitly created Playthroughs start blank. New accounts start with the launch sources and no personal records. Prelaunch donor Builds and mod configurations are not seeded.

The built-in [native gameplay catalog](catalog-sources.md) is installed locally without creating personal records or undo entries. No runtime request is needed. Reference imports add separate immutable catalogs; equal names across sources do not automatically merge. A backup includes the starter revision when personal records or retained history reference it, without inventing an imported source file.

Creating or saving a Game Setup in Data & Settings includes the built-in catalog in the new revision's lock when it is not already pinned. Existing catalog pins remain unchanged. Each Build checkpoint pins an exact Game Setup revision and catalog lock. Editing a Build can save another checkpoint under different rules without changing earlier pins. Teams retain exact checkpoint assignments independently of Playthroughs.

Creating a custom definition adds a standalone locally owned record. Editing it creates another immutable personal record with an exact personal `baseRef` and `previousRevision`. Catalog entries and saved personal definitions whose lineage resolves to a catalog are read-only. Their existing `baseRef`, `previousRevision`, fields, and sources remain supported for imports, backups, shares, and exact saved references. The original catalog and personal revisions remain available. Preferred revisions are suggested by ordinary pickers, while existing Build checkpoints and observations keep their exact references. Stock, learning, and progress use the lineage's logical identity so an edit does not create another owned copy or erase learning.

Reference can collect selected preferred personal definitions into an immutable Game Setup revision. Its `definitionOverrides` field pins exact personal references and its catalog lock includes required source revisions. Collecting replaces selected logical roots in the source layer and retains its other pins. This is an explicit reviewed collection: it does not rewrite selections, substitute new mechanics into historical Builds, or make the resulting revision current. Original sources and all referenced personal revisions remain in native backups; malformed or branched lineage is rejected.

## Supported inputs

| Input | Recognition | Applied data |
| --- | --- | --- |
| Reference workbook | OOXML `.xlsx` with supported named tables | Reference definitions and claims, explicitly supported party progress, and historical acquisition observations |
| Research JSON | Root `schema_version` equal to `1.1.0` | Supported reference arrays and explicit personal mappings; unsupported sections remain source evidence |
| Research package | Bounded ZIP with one unambiguous supported research JSON payload | The same adapter as research JSON, retaining the original package |
| Crystal Edit project | Recognized project JSON with project identity, editor format, and supported structure | An immutable mod catalog and exact original bytes; **Add references** preserves planner records, while enabling Game Setup layers is a separate action |
| Native backup | ZIP containing `manifest.json`, `bundle.json`, and declared source files | Complete planner data, referenced catalog revisions, evidence, and retained history |
| Skill screenshots | Full PNG or JPEG Learn-menu images selected from Characters | Reviewed character-specific square observations and mapped learning; see [screenshot learning](screenshot-learning.md) |

The workbook adapter is for the documented reference-table layout, not arbitrary spreadsheets. Empty template rows do not become characters, possessions, or loadouts. Formula text is inert; a cached spreadsheet value does not establish a verified game rule. Research arrays without an explicit mapper remain available as source evidence instead of being guessed into personal state.

Supported research reference arrays include `classes`, `abilities`, `innates`, `passives`, `monster_magic`, `base_equipment`, `expansion_items`, and `recipes`. Additional research arrays preserve source claims and context. A minimal synthetic input is:

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

## Game save files

Crystal Project `.sav` files are versioned Save documents in the selected workspace. They retain independent exact original and working blob references, inert feature-versioned pending form data, source requirements, coverage diagnostics, and an explicit working-download marker. Full typed file history preserves each retained container and its declared blob/catalog relationships; references inside pending form JSON do not create retaining edges. Guest documents use the complete guest transaction, and account documents use the encrypted account transaction. Native planner ZIP backups retain their planner-only scope; complete workspace backups include these saved file containers and their history. Active mod matching and reviewed mod-state removal do not change the persisted planner format. See [Save Editor compatibility, mod limits, and recovery](save-editor.md).

## Preview and restore

Parsing, archive checks, and schema validation finish before an import transaction begins. The preview identifies the detected format, record groups, warnings, and destination. Canceling the preview leaves stored records unchanged. Reimporting identical source content is idempotent.

Native restore replaces the one local planner-data root only after explicit confirmation. Replacement checks the target revision inside the write transaction and leaves existing data intact if validation or writing fails. Automatic merging is not supported: snapshot counts are never summed, and divergent records are not silently selected by timestamp. Create and switch Playthroughs for separate save lineages within that root.

## Native backup structure

Native backups allow a bounded 128 MiB uncompressed entry and 256 MiB aggregate output so native facts and pinned imported catalog revisions can travel together. The native backup file limit is 32 MiB compressed. Crystal Edit JSON supports sources up to 96 MiB through its separate parser; other import formats retain their own smaller file and extraction limits. Native backup payloads allow four million JSON nodes, Crystal Edit imports allow three million, and ordinary research JSON allows two million. The depth limit, CRC, path, inflation-ratio, and schema checks still apply.

Character snapshots carry `gameSetupRevisionId`, pinning their recorded equipment-slot labels, order, and configuration independently of the Playthrough's current Game Setup. A supplied pin must reference a retained Game Setup revision. Snapshots store equipment by slot ID and passives as a separate ordered list with explicit knowledge state. New captures pin the capture Game Setup revision, and recording a Build as current pins that Build checkpoint's Game Setup revision. Capturing under a changed or previously unrecorded slot context requires selections to be recorded again. Backups retain these pins and all earlier snapshots.

The manifest uses `format: "crykit-backup"`, `formatVersion: "3.0.0"`, and `dataGeneration: "catalog-sources-1"`. It names `bundle.json` and lists each retained source file's identity, filename, format, size, and SHA-256 digest. `bundle.json` contains local planner data, lineage, complete catalog snapshots, evidence, and retained history. Source files occupy declared `sources/*.bin` entries.

Every required catalog body travels in `catalogs`, including vanilla, guides, imported sources, and historical revisions. Package-only pins are unsupported. Restore validates immutable payload checksums, references, and composition dependencies before changing stored data. Removing an old body from the application package cannot invalidate a supported backup.

The launch boundary rejects prelaunch native backups, workspace archives, and planner schemas. Local planner schema `3.0.0` carries `dataGeneration: "catalog-sources-1"`. Prelaunch browser storage is detected by database name without opening, upgrading, or deleting it. **Start new workspace** explicitly initializes the separate launch namespace; canceling or a failed initialization leaves the old storage untouched. Supported launch data retains transactional validation and rollback across future upgrades.

Immutable Team checkpoints own ordered slots and one exact Game Setup and catalog lock. Copying a Build into a Team captures its content and source lineage without changing the Build or its history. Scenario assignments identify either a Build checkpoint or a slot in an exact Team checkpoint. Missing personal definitions require bounded display receipts; those receipts supply no mechanics.

New Team checkpoints retain incompatible selected identities and occupied removed slots in optional private `retainedSelections` receipts. These receipts must exactly match the selections outside the checkpoint context, including catalog revision; duplicate, unselected, or compatible markers are rejected. Exact unavailable-definition receipts may admit a retained catalog identity only when its complete source is absent, never when an available complete catalog lacks that entity. Calculations gate retained identities before resolution even if the old source is locally available, and removed occupied slots keep totals unknown. Save as Build and subsequent copies retain this context and its receipts. Public v6 links project saved choices into bounded selected-entry identity/display receipts, including retained choices and removed occupied slots, without publishing the private marker or mechanical definitions. See [share links](share-links.md) for the public boundary and wire limits.

Legacy-mixed Team records admitted within the launch schema retain their original assignments and metadata until an explicit shared setup is chosen. This internal representation does not admit prelaunch planner payloads. Undo endpoints, retained originals, and historical snapshots must independently satisfy the launch generation and exact source closure.

Build visibility uses an `archived` boolean, independently of tags, immutable checkpoints, Game Setup pins, and tracked party-plan contexts. A save validates operative data and undo history transactionally; failure leaves the previous revision intact.

The manifest reports how many undo checkpoints were available to the export and how many fit. If complete history would exceed the bounded payload, export keeps the newest checkpoints and marks history as truncated; preview reports that limitation. If no checkpoint fits, the exported command journal is cleared so restored planner data does not offer an unavailable Undo action. The complete current facts, required catalogs and evidence, and every referenced source file remain in the backup. Raw rows are retained in evidence alongside the original source bytes, while catalog legacy data contains only unnormalized package metadata so backups do not duplicate every row several times.

The ZIP file is not encrypted. It may contain personal notes and original source files. Export time records when the application assembled the download; it does not prove that the browser saved the file or that a second device restored it. Keep independent backups and periodically test a restore in a separate browser environment.

Unsupported future versions, malformed nested records, broken references, conflicting immutable revisions, corrupt sources, unsafe archive paths, duplicate entries, and excessive expansion are rejected. Limits are defined alongside the parser rather than inferred from a filename. The exporter checks that its output fits the supported container and JSON bounds.

## Storage and recovery

IndexedDB is scoped to the application's origin, including scheme, hostname, and port. Changing the hosting origin opens another database. Persistent-storage permission can reduce eviction risk, but browser storage is not a substitute for an exported file.

Every planner-data write supplies the revision it was based on. The comparison and write occur in one transaction. A stale tab cannot overwrite newer saved planner data. A failed write keeps the open draft available for a recovery export; that draft is distinct from the last committed database revision.

The service worker caches static application assets, including reference data, artwork, and OCR resources. Imported files and personal records stay in IndexedDB, separate from app-file refresh and cache cleanup. Offline readiness is checked against the complete built asset list; persisted-data upgrades use their own transactional migrations.

Launch planner payloads support optional `referenceNames` in Build checkpoint content and `modSourceReceipts` in Game Setup revisions. Display receipts identify selected references, names, and exact mechanical and text contributors. Source receipts describe dependencies; they do not supply definitions or replace complete retained source bodies. Public copied contexts can retain unavailable identities read-only until exact sources are provided. Private source graphs, retained history, and undo checkpoints require complete validated dependencies.

## Unfinished map input

Editor files retain unfinished input separately from the original and last applied content. Map field state preserves coordinate strings exactly, including incomplete signs. Hydration restores those strings without treating selection defaults as new input; explicit selection, reset, movement and history actions own coordinate replacement.

The optional `validationAction` field identifies an attempted `move` or `platform` action, alongside `validationAttempted`. It is inert presentation intent and grants no permission to apply an edit. Reopening shares the complete pure action checks with explicit authoring, including domain bounds and overlap, after required references load. Older drafts without an action remain readable and identify their incomplete validation evidence; an unavailable reference leaves validation unresolved. Successful edits and explicit reset or selection changes clear the attempt.

A saved or uncertain file command whose result cannot reopen retains its exact receipt recovery action, including import before any file is open and removal after a file disappears. Retry reconciles that command through the provider's owner and current-result checks. It cannot create a replacement save or grant a retired owner access to the successor.

Save strict-operation recovery uses a separate read-only receipt verifier. It authenticates the captured journal, selected profile and pointer, full successor closure, and exact saved result without returning repository or continuation authority. Recovery copies read original and working bytes from a fresh selected repository and repeat verification before initiating a download. The rejected input ticket remains rejected; the stored pending payload and latest live form remain distinct. The `crykit-save-recovery` version 1 JSON-lines envelope has byte lengths and SHA-256 digests, inert stored/live payload identities, ordered base64 byte chunks, and a terminating record. CryKit does not import this envelope as command authority.
