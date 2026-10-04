# Development guide

To use the planner, [open the app](https://crykit.lasers.app/). This guide is for running, changing, and verifying the source locally. Read the [project instructions](../AGENTS.md) before contributing.

## Set up the repository

Use Node.js 22.12 or later and npm. Clone the repository, then install the locked dependencies and the repository hooks:

```sh
git clone https://github.com/j-256/crykit.git
cd crykit
npm ci
npm run hooks:install
npm run dev
```

Open the localhost address printed by Vite. The development server binds to `127.0.0.1`.

## Preview the production app

Build and serve the production application to test offline caching:

```sh
npm run build
npm run preview
```

Open the localhost address printed by Vite. Keep using the same origin when entering real records: scheme, host, and port determine which browser database is opened. Export a backup before changing origins or clearing browser storage. Development mode does not install an offline service worker.

Prepare and confirm offline readiness through **Data & settings > Offline & storage**. See [offline use](user-guide.md#use-the-app-offline) for the user workflow.

## Verification

Checks run on the local machine:

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run verify` runs both groups without command-line test filters and records publication evidence for a clean, committed tree. Browser tests use the production build. The desktop project runs every scenario; the mobile project selects tests tagged with `MOBILE_TEST_TAG` from `e2e/test-tags.ts`. Mobile coverage exercises responsive layouts, touch controls, queued tile boards, and representative editing, import, sharing, and offline journeys. Detailed data, validation, calculation, persistence, and recovery combinations run on desktop alongside their unit and component coverage.

Run one project or a focused spec while developing:

```sh
npm run test:e2e -- --project=mobile
npm run test:e2e -- e2e/build-sheet.spec.ts --project=desktop
```

Use `npm run test:e2e:all-devices` to run every scenario on both devices. Its dedicated Playwright configuration removes the mobile tag filter, making the exhaustive matrix available for a broad UI change or a device-specific investigation. Mobile emulation does not establish physical-device installation or verify a phone's native file picker.

Tag a test for mobile when its assertions depend on viewport geometry, touch behavior, mobile navigation or disclosures, or when it supplies a representative mobile journey for a user-facing surface. A generic overflow assertion alone does not require repeating a detailed behavior matrix on mobile. Keep real browser coverage for reload persistence, transactional import and backup recovery, stale-tab conflicts, quota failures, queued clicks, and service-worker updates. Test catalog facts and pure calculation or validation combinations in unit tests, and component state transitions in DOM tests, adding browser scenarios when the integration itself introduces risk.

Each test receives an isolated browser context and establishes its own data. Keep fixtures independent so `fullyParallel` can distribute individual tests across shards. Avoid shared mutable files, external services, or suite-wide state. CI runs each shard with one worker, retains per-test durations in a `browser-timings` artifact, and preserves traces and screenshots on failure. Compare timings on the same runner and build before changing workers, diagnostic capture, or timeouts; local performance does not establish CI runtime.

## Publication verification

During implementation, run focused checks for the affected flows. When changing shared routes, presentation, catalog interpretation, or persistence, review assertions in every consumer and tests introduced by synchronization. Establish the intended behavior before updating an expectation: a failing assertion may identify a regression rather than an obsolete test.

Feature tests use `referencePath` and `referenceUrlPattern` from `e2e/reference-helpers.ts`; these delegate formatting to the application's route formatter. Explicit URL strings and regexes remain in `e2e/entity-urls.spec.ts` and the navigation unit contracts, so a shared formatter bug can still fail independent expectations. `npm run check:e2e-contracts` rejects duplicated catalog paths and colon-based identity serialization in ordinary E2E source. It runs in deterministic checks, CI, and the pre-push hook. The reviewed contract-file exception is narrow; expanding it requires treating the new tests as independent format contracts.

Bundled Reference links use `#/reference/catalog/v1/<entityPath>/<name-slug>`, for example `#/reference/catalog/v1/base/item/203/quintar-berries` and `#/reference/catalog/v1/mod/equipment-expansion/equipment/592/heavy-edge`. The `v1` alias pins the bundled catalog and its revision. Imported catalogs and composed Game Setups use `#/reference/catalog/<catalog>/<revision>/<entityPath>/<name-slug>`; a literal imported catalog ID matching `v<number>` escapes its first character to keep it distinct from an alias. Personal definitions use `#/reference/personal/<definition>`. Entity IDs resolve the definition; name slugs describe it and normalize without adding a browser history entry. Superseded pre-release catalog keys and route formats have no compatibility aliases.

Catalog assembly compiles reviewed source identities into native database IDs and mod model IDs, scoped by database family, mod project, and native mode. Source inputs keep their original join keys and provenance. Definitions without a verified source identity receive permanent allocations from `src/catalog/supplemental-entity-ids.json`, yielding keys such as `base:other:ref-909`. Allocate above the largest existing number, keep allocations when an entry is removed or gains a source ID, and never derive numbers from ordering or reuse them. Compilation rejects missing allocations and identity collisions, updates typed catalog references and evidence targets, and compiles artwork bindings into the same keys. Runtime lookups and route parsing use the compiled keys directly.

Reference and Inventory category filters exchange stable keys rather than display labels. `reference-categories.ts` defines equipment keys, labels, and source taxonomy adapters. Native and Crystal Edit equipment records resolve their numeric `EquipmentType` through the same registry; imported source tags use a separate escaped namespace. Source labels support imports and category searches; they do not define URL values. Category projection leaves immutable catalogs and saved personal records unchanged. Keep label rendering separate from query matching, URL values, facet counts, and selected-state comparisons.

Before publication, commit the finished changes, synchronize with the integration branch, and run:

```sh
npm run verify
```

The command executes deterministic checks followed by the complete configured browser suite: every desktop scenario and the selected mobile scenarios. It records success only when the source starts committed and clean and remains on the same Git tree throughout verification. A dirty checkout can be tested, but it produces no publication evidence. A failed or interrupted rerun invalidates prior evidence before checks begin. `npm run check` and focused Playwright runs do not create this record.

The pre-push hook checks the actual object IDs supplied by Git, including explicit task-branch pushes from another linked worktree. Every published tree requires a successful record for the repository and the same Node version, platform, and architecture. Any changed tree, including files added by synchronization, requires another complete run. Commit metadata changes that preserve the tested tree reuse its evidence. Deleting a ref does not require a record. The hook reports the missing tree and the command to run; it never starts browser tests or silently publishes changes.

Records use schema version 1 under `${XDG_CACHE_HOME:-$HOME/.cache}/crykit-verification/`, scoped by the Git common directory, tree, and runtime. Linked worktrees share records, while separate clones do not. They are regenerable local cache files and contain no credentials or test artifacts. Removing the cache requires re-verification. These records do not certify ignored files or arbitrary dependency mutations, and Git hooks can be deliberately bypassed; the protected `release-ready` CI check remains the authoritative merge gate. Keep dependencies consistent with the lockfile using `npm ci`.

On a fresh checkout, install the hooks with `npm run hooks:install` and Chromium with `npx playwright install chromium`. `CRYKIT_E2E_PORT` selects the preview port when another local task uses the default. Queue approval remains separate from implementation and verification. Under the CI-only queue policy, the local pre-push check enforces publication evidence while hosted checks independently verify the synchronized PR head.

The [revision 2 specification](spec-v2.md) defines data boundaries, core workflows, and acceptance gates. [Build mechanics](planner-mechanics.md) documents the supported calculations and their limits.

## Data boundaries and contribution privacy

Keep catalog definitions, personal observations, and planned configurations separate. Preserve explicit unknowns. Use synthetic fixtures when testing; do not commit personal records.

IndexedDB format 5 upgrades persisted bundled source identities to the compiled catalog IDs. Planner roots and undo history migrate together in one transaction, including character progress keys and reviewed mod composition link targets. The upgrade uses the source compiler's exact mapping, preserves record IDs, pins, unknown values, and opaque source fields, and rejects collisions or unresolved references without partial writes. Imported catalog snapshots and archived source bytes remain unchanged.

Original workbooks, trackers, personal exports, and private screenshots do not belong in this repository. Commit hooks check staged content for common private artifacts, credentials, machine paths, and unreviewed workflow files. These checks support human review; they do not certify data rights or detect every possible private fact.

Use [GitHub issues](https://github.com/j-256/crykit/issues) for bugs, source corrections, and attribution concerns. Include reproducible steps and synthetic examples. Include the reference entry, platform, game version, enabled mods, expected value, and source evidence. Source fixes belong in the catalog extraction or interpretation pipeline. See [reference data boundaries](reference-data.md) for the distinction between source catalogs, standalone custom definitions, and retained catalog versions.

## Bundle a mod source directory

Package a directory of Crystal Edit exports without maintaining a filename list:

```sh
npm run mods:library:bundle -- --input-directory /path/to/mods
npm run mods:library:check
```

The bundler scans JSON files recursively, skips symlinks and unrelated JSON, deduplicates identical bytes, and preserves distinct revisions of the same project. Refreshing retains previously bundled revisions. Invalid JSON, unsafe identities, or detected private content fail before writing. Review the sources and attribution before committing; automated privacy checks do not establish content rights.

Generated sources live in `src/assets/mod-sources/` as immutable digest-named gzip/base64 JSON assets. `src/catalog/bundled-mod-sources.json` records project metadata, model IDs, and source digests without input paths. Runtime loaders discover these assets by directory glob and recover the exact UTF-8 bytes, including BOM and line endings. The check command decompresses and validates every source against its manifest without needing the input directory, and is included in `npm run check`. Full sources load on demand and are included in offline preparation. Mod catalog browsing decodes only the selected source in a temporary Reference provider, without writing to the local archive. Saved project revisions take precedence over the bundled source. Explicit **Add to Reference**, editor saves, and imports persist supported definitions and original bytes. Reference membership uses optional versioned settings in local planner data; removal preserves the archive and game configuration. Importing a previously removed source preserves its exclusion unless an explicit Add action atomically restores membership. This pipeline does not change the default planning catalog or enable mods automatically; reviewed normalized definitions retain their separate generation commands.

## Native world map

The map source pipeline produces `src/catalog/world-map.json` and layer PNGs in `src/assets/world-map/` from a fingerprinted Windows PC 1.6.9 installation. Use .NET SDK 10 and the locked Node dependencies to regenerate it:

```sh
npm run world-map:update -- --input <installation-or-Content>
npm run world-map:check
```

The offline check uses committed assets and does not need an installation. See [native map sources](catalog-sources.md#native-world-map) for rendering, provenance, and rights. Keep installation paths, raw world exports, and player saves outside tracked content.

`src/domain/world-map.ts` projects source-backed markers and composes ordered Crystal Edit entity and definition overrides without React or saved-data mutations. Preserve exact source revisions and numeric entity identities when applying mod layers; later layers replace the same entity instead of creating duplicate vanilla markers. An invalid replacement must remain unresolved rather than silently restoring a vanilla placement. Terrain overrides and unknown layer assignments need explicit diagnostics. Source text, scripts, and formulas are data and must never execute.

The map page is lazy-loaded. The viewport uses a spatial index, clusters nearby markers, and limits rendering to visible placements. Search reveals the selected marker and its layer, with source details and supported Reference links. Marker colors have separate source labels. Keep map previews independent of persisted Game Setup selection and Playthrough observations, and preserve Build drafts during research navigation. Browser coverage checks desktop and mobile navigation, zoom and layers, source previews, imported placements, reference links, draft detours, and prepared offline rendering.

## Interface and artwork

Immediate-save tile boards use the shared [queued tile update pattern](queued-tile-updates.md). Reuse its hook, application save queue, stable rendering, and verification approach when adding another board.

Save failures remain visible in a persistent alert below the application header while scrolling. A retained unsaved revision exposes **Retry save** and stays visible until resolved. A rolled-back change exposes **Dismiss** without changing the saved data or removing action-specific recovery. Reference membership actions bring their success or failure into view on the affected mod card. Failures retain the requested membership for retry and include diagnostic details. Warning and failure notices use contrasting backgrounds, readable body text, and a marked border across the application. Browser coverage checks confirmations, alerts, and retry controls against the sticky headers and mobile navigation.

The interface takes its visual cues from Crystal Project's menus: charcoal windows, silver borders, cyan dividers, blue selections, and pixel headings. [Pixel Operator](https://www.dafont.com/pixel-operator.font) by Jayvee Enaguas is a readable substitute for the game's lettering, not a verified match to its original typeface. It ships locally under [CC0](../public/pixel-operator-CC0.txt), with regular weight, disabled ligatures, and fixed type sizes. Body text and compact section headings use system fonts for readable descriptions and forms. Native UI artwork uses explicit manifest bindings. Reference artwork prefers exact native game bindings, then supported mod cells, then mapped wiki fallbacks. Decorative artwork does not represent recorded inventory or progress. See [artwork rights and refresh instructions](catalog-sources.md#native-game-artwork-snapshot).

## Static hosting and deployment

Serve `dist/` from a secure origin. Hash routes and relative asset URLs support a subdirectory. Offline preparation requires HTTPS or a browser's trusted localhost context. Prepare the production app while connected, then check its offline status before relying on it without a connection. App updates are staged for explicit activation; browser storage still needs external backups.

The hosted app uses an assets-only Cloudflare Worker at `crykit.lasers.app`. The retained aliases `crycom.lasers.app`, `cp.lasers.app`, `crystal.lasers.app`, `crystal-companion.lasers.app`, and `crystalcompanion.lasers.app` use HTTP 307 redirects that preserve the request method, path, and query. See [deployment and recovery](deployment.md) for configuration, the public-only CI sequence, and Free-plan limits. Local builds do not need Cloudflare credentials.

Development and verification can run entirely locally. The public repository also verifies changes and deploys main with GitHub Actions. Actions must remain disabled whenever the repository is private; the workflow retains a public-repository guard.

Keep the application license and third-party notices with redistributions. See [credits and licenses](../NOTICE.md).

## Loadout presentation

Planning pages use the Shell's persistent command header for their page or object title and actions. `ScreenHeader` portals into `WorkspaceHeaderContext`; tracking pages and isolated components retain inline headings. Builds keep their editor checkpoint selector in the header and expose rename, tags, cloning, and other secondary commands through More. Dismissing More preserves unfinished metadata drafts and their navigation guard.

Build editors stack below a collapsible library at widths up to 1120 pixels. Keep `STACKED_BUILD_LAYOUT_QUERY` aligned with the CSS breakpoint so selecting a Build collapses the library when the editor needs the full content width. Loadout grid tracks must shrink to their container across platform font metrics; wide tables scroll within their own wrappers.

`WorkspacePrimaryAction` moves Build and Team save controls into that header while their existing page forms own draft state, validation, persistence, and failure recovery. Associate each portaled submit button with its native form ID so browser validation runs before saving. Keep the checkpoint and metadata save semantics distinct, and use explicit button types for commands that do not submit forms. The Shell measures the context region for mobile scroll padding so sticky controls remain reachable when its height changes.

The build editor, share preview, and current character editor use `src/ui/LoadoutSheet.tsx` for section order, the Loadout and Checks & notes views, definition inspection, and calculation panels. The selection inspector stays present with an empty prompt before inspection, keeping the two-column layout stable in wide containers and stacking below the fields in narrow containers. The stats overview keeps fixed class growth ratings visible alongside numeric base and equipped values using the selected level and growth history. The selection inspector omits a duplicate rating panel for the primary class and retains ratings when inspecting another class. Checks & notes keeps native coefficient-power and base physical hit-curve previews available, including plans without a model marker. Add common presentation there so the three surfaces stay aligned. Each surface supplies its class, equipment, and passive fields and owns its save behavior.

Build editing retains checkpoint drafts, slot allocations, behavior presets, and revision saves. Share previews resolve definitions from the decoded graph and exact catalog pins, and omit calculation mutation callbacks to display saved inputs without edit controls. Character editing retains `Knowledge` values, unrecorded slots, recorded level and displayed totals, and snapshot saves. Its build-shaped calculation adapter supplies explicit unknown-input flags; it does not convert unknown observations into known empty selections. Calculation assumptions remain distinct from in-game observations. These presentation adapters do not change persisted formats or share-link versions.

Build forms mark native controls dirty on change, after the control's own handler updates the draft. Marking them dirty on input can rerender and reset a controlled select before its change event reads the selected value.

Build edit drafts without saved calculation inputs start with a level-60 native plan following the primary class, without rewriting the saved checkpoint. Explicit unknown levels remain unknown. Character sheets offer an explicit level-60 plan, and read-only shares preserve absent plans. Plans without a model marker use the same native PC evaluator and retain their saved inputs; unsupported custom bonuses and active statuses remain unresolved. Editing calculation controls supplies a plan through the surface's existing save behavior and does not update recorded observations. Unavailable totals show the blocking reason and relevant recovery controls, while known components and recorded stats remain visible.

The overview uses the pure `calculateStatBreakdownResult` domain function for Base, Equipment, Level, Gender, Total, and diagnostic reasons. It omits columns with no available values. Base uses a level-1 primary-class baseline. Equipment includes the loadout's passive effects, and Gender measures its effect after modifiers and rounding. Calculation gender is an optional saved plan input; read-only sheets show its label while editable sheets supply it through their existing calculation callback. Do not infer recorded character gender or rewrite older plans that omit it. See [the calculation package](calculations.md) for formula scope and contribution semantics.

Gender records resolve from the pinned setup with explicit flag validation. Additional identities use versioned calculation selections; missing identities remain saved and unresolved. Mod composition version 2 covers native innate references, changed innate kinds, and text-only localization while historical compositions preserve their original projections. Parser changes create new immutable source revisions. Maintain the [editable-data and engine-rule boundary](mod-calculations.md) when adding calculation coverage, and verify collisions in added identities, backup/share round-trips, save rollback, and offline rendering.

Rule explanations in `game-rule-labels.ts` use inspected native consumers to supply plain-language labels, effect descriptions, value units, and calculation scope. `TechnicalFieldInfo` exposes the exact source field through hover, focus, and tap help with Escape dismissal. Keep source names and numeric values intact, leave unfamiliar effects explicit, and verify both keyboard and touch access when extending the rule presentation. Collapsed Build summaries resolve names from exact enabled catalog pins; named-only settings do not establish calculation support.

When changing these components, verify definition inspection, native plans with and without model markers, read-only share previews and saved copies, unknown character observations, save failure retries, and desktop and mobile layouts. The sharing and character sheet browser tests cover those flows, including offline rendering and preview-to-editor calculation parity.

### Team member editing

Teams reuse the Build editor in an embedded mode with local picker state. The Team parent retains its name and slot draft while editing a member. `saveTeamMember` composes Game Setup, Build, immutable checkpoint, and Team updates into one candidate; the application commits it with rollback on failure. Mod-backed selections and growth references are rebound to the saved setup's catalog pins before creating the checkpoint. Navigation to a newly saved Team occurs after the member editor unmounts so its dirty guard cannot block a successful save. Other slots and Teams retain their checkpoint IDs.

Build pickers assess replacements against the complete draft using the domain equipment rules. UI filters never change saved selections. The optional innate visibility preference uses a versioned localStorage key, falls back to the setup on unavailable storage, and is separate from checkpoint content. Full four-member browser coverage exercises creation, equipment, passives, persistence, and independent sharing; focused tests cover failed member persistence and explicit revision updates.
