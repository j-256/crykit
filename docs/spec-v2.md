# Crystal Companion specification, revision 2

Date: 2026-09-24. This is the implementation contract for a local inventory, character, and party planner. It replaces the first proposal's conflicting release priorities and unsupported assumptions about its input package. Private source documents and playthrough examples are deliberately excluded.

## Product boundary

The core journey is record, search, select, compare, check, and plan. Reference definitions describe documented game content; observations describe what a player explicitly recorded; builds and teams describe alternatives. Editing one layer must never silently mutate another. The application does not connect to a console, change a game save, buy equipment, learn abilities, or infer events from plans.

A new installation starts with one local planner-data root, a labeled synthetic sample Playthrough and team, reusable sample Builds, one Game Setup, and a partial public names catalog. Explicitly created Playthroughs start without tracked records but share Builds, Game Setups, and reference data. A player can explore the sample, search references immediately, import local research, create unmatched entries, or record a character without completing a catalog. Missing data restricts conclusions while preserving the ability to record facts. Built-in names and sample observations do not establish platform applicability or game mechanics.

The first complete release comprises data-preserving storage, useful tracking, and descriptive build/party planning. It does not require damage simulation, displayed-stat prediction, optimization, OCR, hosted synchronization, or a complete game database. There is no universal build score. Item-listed values and observed final character stats remain separate.

## Decisions resolving revision 1

| Topic | Decision |
| --- | --- |
| Available research format | Support the supplied tabular XLSX structure directly. A research JSON adapter is separately versioned; supporting its schema is not proof that an unavailable exact package was tested. Native backups use a ZIP container with a versioned JSON manifest/payload and original local source files. ZIP support is bounded and accepts only an unambiguous supported payload. |
| Personal baseline | Labeled synthetic sample records on first use; real observations come from local entry or explicit imports. Original specifications, trackers, workbooks, exports, screenshots, and private fixtures are excluded from source control and static assets. |
| First-release comparison | Basic descriptive comparison and immutable build checkpoints are required. Rich revision graphs and automated ranking are separate enhancements. |
| Cross-device transfer | Export and restore complete native backups. Replacement of the one local planner-data root is explicit and transactional. Preserve divergent files rather than guessing a merge or summing snapshot counts. |
| Catalog upgrades | Retain immutable snapshots and build locks. A new catalog must not rewrite a saved revision. Explicit build rebasing creates a new checkpoint. |
| Slots and PP | Game Setup revisions contain editable slot definitions and capacity/cost knowledge. Suggested slots are a user configuration, not a verified claim about a platform or mod. |
| Game mechanics | Typed, scoped rules only. Descriptions, spreadsheet formulas, and planner notes remain inert text. Unknown applicability yields an explained unresolved result. |
| Publication | Publish generic application code, documentation, synthetic fixtures, and reviewed public reference material with source attribution. Private inputs remain excluded. Reference content and artwork retain rights independent of the code license; see [credits](../NOTICE.md). |
| CI | GitHub Actions stays disabled while the repository is private. Verify public visibility before enabling the reviewed public-only workflow. Build, security, and browser verification also run locally; see [deployment](deployment.md). |
| Deployment | The app builds as portable static files, including under a subpath. No public host, custom domain, account, or backend is required. |
| Optional depth | Evidence attachments, rich audits, three-way merge, advanced saved queries, recipe execution, and numerical engines may ship independently after the complete core. Unsupported operations must be described honestly rather than represented by nonfunctional controls. |

## Architecture and authoritative data

Use strict TypeScript, React, Vite, IndexedDB through Dexie, runtime import validation, and pure domain functions. A single database holds one local planner-data aggregate, immutable catalog snapshots, attachment records when supported, and application metadata. The service worker caches application assets; it is not the owner of personal records.

One local planner-data aggregate makes shared reference data, Game Setups, Builds, Playthroughs, and their bounded journal atomic. A Playthrough is one save lineage and owns tracked characters, inventory, progress, and scenarios. Builds and versioned Game Setups are shared. Every save includes an expected revision checked inside the same IndexedDB transaction as the write. A stale tab receives a conflict, preserving its draft. A notification can refresh another tab, but notification delivery does not establish correctness.

Catalog snapshots carry identity, revision, digest, source metadata, raw/unmapped fields, and normalized entities. Namespaced source IDs survive imports. Equal display names do not merge different entity types or source namespaces. A digest detects byte changes, not authenticity, accuracy, or permission to redistribute.

Knowledge is known, unknown, conflicting, or not applicable. Values preserve provenance and source locators. Known zero differs from an empty cell; a false observation differs from no observation. Import/check timestamps never substitute for gameplay event dates. Catalog coverage is descriptive metadata, not certification of mechanics or platform parity.

Each Build belongs to one logical Game Setup. Build checkpoints are immutable and pin exact Game Setup and catalog revisions. A Build is applicable when its logical Game Setup matches the Playthrough's current Game Setup; a different revision in the same logical setup remains compatible. Inapplicable Builds remain visible below applicable Builds, muted and accompanied by an explicit explanation. They are inspectable and can be forked into the current Game Setup, but they are not directly editable there. Working drafts can change without updating a checkpoint or a team's pinned selection. Old checkpoints remain inspectable when a later reference changes or removes an entry.

Personal definition edits append immutable overrides with exact source and predecessor references. Ordinary pickers prefer the latest revision, while stock and learning retain logical identity and saved selections retain their exact definition. Selected overrides can be collected into a new Game Setup revision with explicit pins and source catalog locks. Collection preserves other pins and does not make the new revision current or rewrite existing Builds.

## Required workflows

### Inventory

Support fast name search, category/source/ownership filters, unmatched item entry, exact/at-least/unknown quantity, notes, favorite, protection, and wishlist. An observation sets current stock. An acquisition/loss reports an event. These are distinct commands with distinct history.

Current ownership means at least one copy unless an exact count was supplied. Exact zero means not owned. Historical acquisition alone establishes neither current possession nor a lower bound. Counts include equipped copies. Partial imports and audits do not zero omitted items.

Scenario allocations evaluate simultaneous use. Alternative saved builds do not reserve anything. Replacing a character's scenario selection replaces its previous assignments. Unchanged observed party members remain included when the scenario uses that baseline. Exact stock below demand is a shortage; a sufficient lower bound establishes sufficiency; an insufficient lower bound with unknown upper bound is unresolved.

### Characters

Capture identity, observed level/classes, displayed final stats, ordered gear/passives, observation time, and source note. Track character class mastery, learned abilities/passives, and Monster Magic independently. Party progress, catalog presence, and seal collection never populate those records. Passive PP uses the pinned Game Setup limit, which defaults to 10 and can be overridden by a modded Game Setup.

Member presents one recorded observation in a compact class, command, equipment, passive, Learn, and Status menu. Recorded vitals remain visible above the menu. Ordinary slot choices edit an inline draft, and saving appends an immutable observation. Desktop details accompany the selected row; touch layouts reveal its details inline. Observation metadata and planned Builds use secondary disclosures. Learn combines class progress and learned-node observations without inferring either from the other. History inspects immutable snapshots and compares recorded fields, keeping unknown, unrecorded, conflicting, not applicable, and empty values explicit. Numeric deltas require matching fields and units with known values on both sides; no causal or calculated-stat claim follows. Class learning and Monster Magic records are not part of these snapshots and do not gain invented historical changes. Snapshot slot labels come from their pinned Game Setup revision.

A build can be recorded as a current observation after a visible diff and explicit in-game confirmation. The action must not manufacture gear or learning. A real observation may conflict with catalog claims; preserve both and expose the discrepancy.

### Builds and teams

Provide a searchable library, drafts/templates, clone, named immutable checkpoints, configurable ordered slots, passive selection, class selection, notes, and contextual pickers. Keep recorded current, draft, and hypothetical contexts visible. A class change retains selections and displays resulting issues.

Compare two checkpointed alternatives by selections, known costs, raw/typed listed contributions, documented effects, missing learning, and stock. Missing values remain unresolved rather than tying at zero. Provide a basic actionable requirements list that separates known shortages from facts needing confirmation.

Teams bind characters to immutable Build checkpoints. They show simultaneous stock contention, protected selections, learning gaps, and Game Setup mismatch with the affected item or character. Teams do not infer shared class mastery or globally reserve equipment.

### Progress and reference

Party-wide progress records collection, mastery, unlock/progress, evidence, and master-location claims separately. Hide master locations on collected rows in ordinary progress views while retaining them in source detail. A location is not an inferred route or class-unlock crystal.

Reference search covers items, classes, abilities, innates, passives, Monster Magic, locations, recipes, source claims, and conflicts present in an imported pack. Display raw descriptions, source scope, missing values, and conflicts. Source links open only by explicit user action after a scheme allowlist check.

### Search

Use a structured query tree and three-valued predicates. Ordinary multiselect alternatives combine with OR, different facets with AND. NOT unknown remains unknown; false AND unknown is false; true OR unknown is true. Distinguish confirmed matches from possible matches. Missing numeric fields are not zero and units cannot be compared interchangeably.

Raw-text matches are labeled as text, not asserted as verified effects. Pickers use the same search and validation functions with explicit slot, Game Setup, character, and scenario context. Browser Back restores the relevant query and picker route. Stable secondary sorting prevents rows from jumping unpredictably.

Every game-definition field is a searchable picker with inline creation and editing. Cmd/Ctrl+K and visible desktop/mobile controls open universal search over definitions and local records. Keyboard navigation, Escape, and focus restoration work with nested editors. Choosing a result opens the exact record, and navigation cannot discard an open form or unsaved Build revision.

## Validation contract

Every check receives explicit inputs rather than reading React state or storage. Results include a stable code, dimension, status, relevant selections, explanation, and suggested correction. Separate structural integrity, equipment legality, passive legality, character readiness, inventory sufficiency, Game Setup certainty, and calculation readiness.

A proved violation dominates uncertainty within its check. Missing unrelated coordinates must not block equipment legality. Unknown PP costs cannot produce an exact remaining budget. A known subtotal over a known Game Setup limit proves failure only when costs are constrained to be nonnegative. Missing equipment permissions do not mean unrestricted use. Unsupported dependency cycles cannot validate themselves.

No calculation interprets imported prose as executable code. Full displayed-stat prediction requires verified base inputs, mod applicability, stacking, caps, order, and rounding. A growth rating or syntactically parsed stat token is insufficient. The separate class growth calculator uses attributed guide equations, explicit level allocations, and class ratings to estimate unequipped base stats. It retains missing inputs as unknown and never writes an estimate into an observed character record; see [Class data, Crystal Edit imports, and growth estimates](crystal-edit.md).

## Interchange and durability

Detect formats from content as well as filename. Parse, bound, normalize, and validate before opening a short write transaction. Show a preview separating reference, personal, and mixed/source material, along with warnings and the proposed destination. Canceling or failing leaves stored planner data intact. Reimporting identical source content is idempotent.

The XLSX adapter reads OOXML tables through package relationships, excludes empty template rows, preserves cell locators/raw values, and treats formulas as inert text with separately identified cached values. Reject external relationships, DTD/entity declarations, path traversal, duplicate archive names, oversized entries, excessive expansion, unsupported encryption, and malformed/truncated archives. No import follows a URL or executes formulas/HTML.

The native backup uses a ZIP container with its own JSON format name and schema version. It includes planner-data identity and revision, all Playthroughs, shared Builds and Game Setups, referenced immutable catalogs, source metadata, retained history, and evidence or source bytes when selected. Export a failed-save draft as well as persisted state. Unsupported schemas reject without writes. Replacing the local planner-data root requires a visible preview and explicit confirmation.

Show saved status only after the transaction commits. Preserve drafts on quota, availability, migration, or revision errors and offer retry/export/reload choices. Request persistent storage where supported, but never describe browser storage as a backup. Record export time and revision, without pretending to verify the file after download.

## Offline, security, and updates

Cache the complete production shell and required built assets. Offline ready means those assets were checked successfully. Once ready, reference/inventory edits, characters, builds, validation, and native export work without a connection. Development-server availability is not offline verification.

Stage service-worker updates and apply them only through an explicit action. Never force a reload over a draft. Keep old cached assets usable for existing tabs. Personal records remain in IndexedDB across shell updates.

Use a restrictive production CSP, no telemetry or remote fonts, no runtime scraping, no dynamic code evaluation, and no imported HTML rendering. Treat attachment bytes, URLs, JSON keys, archive names, and saved queries as untrusted. Do not log personal records or source file contents. Bound expensive operations and preserve a responsive cancel/recovery path.

## Presentation and accessibility

Use Inventory, Characters, Builds, Progress, and Reference as the primary destinations. Data/settings contains imports, backups, Playthrough selection, Game Setup configuration, history, storage, and offline/update status. Keep the active Playthrough, current Game Setup, save state, and scenario context visible where they affect results.

Desktop can use a navigation rail and adjacent selection/detail panels. Mobile uses a compact header and bottom navigation. Definition choices use searchable dropdowns anchored to their fields on both layouts, keeping the surrounding form usable. Larger editing workflows use centered dialogs with a dim, unblurred backdrop and a scrolling body constrained to the viewport. All core actions need visible keyboard focus, semantic labels, touch-sized controls, and no hover or dragging dependency. Status uses text as well as color. Empty states offer the next useful action.

Every page, selected record, tab, and modal workflow has a semantic URL. Use readable hash-path segments with bounded exact identifiers so static hosting, subdirectory installs, and offline navigation remain supported. Nested pickers and definition editors retain their parent route. Direct entry, refresh, in-app navigation, and browser Back/Forward use the same navigation state. A rejected draft-losing navigation restores the accepted route without replacing the destination history entry.

URLs do not contain unsaved form fields or imported file bytes. Missing local records, unavailable revisions, malformed routes, and expired import previews show explicit recovery instead of substituting a different record. Source facets remain readable and searchable at narrow widths, use bounded scrolling for long option lists, and preserve full source identities and explicit links.

## Local verification gates

| Gate | Required evidence |
| --- | --- |
| Privacy | Reviewed tracked tree and history, no personal fixtures or personal static seeds, no credentials/machine paths, no hosted workflow runs while the repository is private |
| Import | Synthetic schema/security fixtures plus local real-workbook assertions; source state retained without invented characters, learning, possession, quantities, or dates |
| Domain | Quantity/PP bounds, three-valued logic, separate party/character state, same-name identity, alternative versus simultaneous allocations, replacement semantics, revision locks |
| Persistence | Real IndexedDB browser flow plus integration tests for atomic save/import, expected revision, rollback, unsupported backup, explicit planner-data replacement, Playthrough isolation, and failed-save draft recovery |
| UI | Desktop/mobile import, search, manual entry, character capture, build/checkpoint/compare, team conflict, progress, backup/restore, keyboard and focus checks |
| Offline | Production cache readiness, disconnect/reload, edits/validation/export, staged update behavior, and static subpath loading |
| Quality | Strict typecheck, meaningful local tests, production build, local dependency audit, browser error inspection, and accessibility review |

Emulated mobile checks do not establish physical-device installation or phone file-picker behavior. Report that limit explicitly. Benchmarks must state dataset and machine conditions and must not imply target-phone performance from desktop measurements.

## Technical references

Implementation references are [Vite](https://vite.dev/guide/), [Dexie transactions](https://dexie.org/docs/Dexie/Dexie.transaction()), and [service-worker lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers). Their capabilities are verified by local tests before being relied upon for the application's behavior.
