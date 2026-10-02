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

Original workbooks, trackers, personal exports, and private screenshots do not belong in this repository. Commit hooks check staged content for common private artifacts, credentials, machine paths, and unreviewed workflow files. These checks support human review; they do not certify data rights or detect every possible private fact.

Use [GitHub issues](https://github.com/j-256/crykit/issues) for bugs, source corrections, and attribution concerns. Include reproducible steps and synthetic examples. The [correction guide](corrections.md) explains how to export reference corrections separately from playthrough records.

## Bundle a mod source directory

Package a directory of Crystal Edit exports without maintaining a filename list:

```sh
npm run mods:library:bundle -- --input-directory /path/to/mods
npm run mods:library:check
```

The bundler scans JSON files recursively, skips symlinks and unrelated JSON, deduplicates identical bytes, and preserves distinct revisions of the same project. Refreshing retains previously bundled revisions. Invalid JSON, unsafe identities, or detected private content fail before writing. Review the sources and attribution before committing; automated privacy checks do not establish content rights.

Generated sources live in `src/assets/mod-sources/` as immutable digest-named gzip/base64 JSON assets. `src/catalog/bundled-mod-sources.json` records project metadata, model IDs, and source digests without input paths. Runtime loaders discover these assets by directory glob and recover the exact UTF-8 bytes, including BOM and line endings. The check command decompresses and validates every source against its manifest without needing the input directory, and is included in `npm run check`. Full sources load on demand and are included in offline preparation. Mod catalog browsing decodes only the selected source in a temporary Reference provider, without writing to the local archive. Saved project revisions take precedence over the bundled source. Explicit **Add to Reference**, editor saves, and imports persist supported definitions and original bytes. Reference membership uses optional versioned settings in local planner data; removal preserves the archive and game configuration. Importing a previously removed source preserves its exclusion unless an explicit Add action atomically restores membership. This pipeline does not change the default planning catalog or enable mods automatically; reviewed normalized definitions retain their separate generation commands.

## Interface and artwork

Immediate-save tile boards use the shared [queued tile update pattern](queued-tile-updates.md). Reuse its hook, application save queue, stable rendering, and verification approach when adding another board.

The interface takes its visual cues from Crystal Project's menus: charcoal windows, silver borders, cyan dividers, blue selections, and pixel headings. [Pixel Operator](https://www.dafont.com/pixel-operator.font) by Jayvee Enaguas is a readable substitute for the game's lettering, not a verified match to its original typeface. It ships locally under [CC0](../public/pixel-operator-CC0.txt), with regular weight, disabled ligatures, and fixed type sizes. Body text and compact section headings use system fonts for readable descriptions and forms. The bundled crystal artwork and menu icons ship with the app; decorative artwork does not represent recorded inventory or game progress. Reference entries also show locally bundled wiki sprites and icons where an explicit source mapping exists, with per-file attribution and separate [artwork rights and refresh instructions](catalog-sources.md#sprite-and-icon-snapshot).

## Static hosting and deployment

Serve `dist/` from a secure origin. Hash routes and relative asset URLs support a subdirectory. Offline preparation requires HTTPS or a browser's trusted localhost context. Prepare the production app while connected, then check its offline status before relying on it without a connection. App updates are staged for explicit activation; browser storage still needs external backups.

The hosted app uses an assets-only Cloudflare Worker at `crykit.lasers.app`. The retained aliases `crycom.lasers.app`, `cp.lasers.app`, `crystal.lasers.app`, `crystal-companion.lasers.app`, and `crystalcompanion.lasers.app` use HTTP 307 redirects that preserve the request method, path, and query. See [deployment and recovery](deployment.md) for configuration, the public-only CI sequence, and Free-plan limits. Local builds do not need Cloudflare credentials.

Development and verification can run entirely locally. The public repository also verifies changes and deploys main with GitHub Actions. Actions must remain disabled whenever the repository is private; the workflow retains a public-repository guard.

Keep the application license and third-party notices with redistributions. See [credits and licenses](../NOTICE.md).

## Loadout presentation

The build editor, share preview, and current character editor use `src/ui/LoadoutSheet.tsx` for section order, the Loadout and Checks & notes views, definition inspection, and calculation panels. The stats overview keeps fixed class growth ratings visible alongside numeric base and equipped values using the selected level and growth history. The selection inspector omits a duplicate rating panel for the primary class and retains ratings when inspecting another class. Checks & notes keeps native coefficient-power and base physical hit-curve previews available, including plans without a model marker. Add common presentation there so the three surfaces stay aligned. Each surface supplies its class, equipment, and passive fields and owns its save behavior.

Build editing retains checkpoint drafts, slot allocations, behavior presets, and revision saves. Share previews resolve definitions from the decoded graph and exact catalog pins, and omit calculation mutation callbacks to display saved inputs without edit controls. Character editing retains `Knowledge` values, unrecorded slots, recorded level and displayed totals, and snapshot saves. Its build-shaped calculation adapter supplies explicit unknown-input flags; it does not convert unknown observations into known empty selections. Calculation assumptions remain distinct from in-game observations. These presentation adapters do not change persisted formats or share-link versions.

Build forms mark native controls dirty on change, after the control's own handler updates the draft. Marking them dirty on input can rerender and reset a controlled select before its change event reads the selected value.

When a saved calculation or its level is absent or unknown, calculated totals remain unknown. Editable sheets offer an explicit level-60 plan with growth following the primary class. Plans without a model marker use the same native PC evaluator and retain their saved inputs; unsupported custom bonuses and active statuses remain unresolved. Editing calculation controls supplies an explicit plan through the surface's existing save behavior and does not update recorded observations.

The overview uses the pure `calculateStatBreakdown` domain function for Base, Equipment, Level, Gender, and Total. Base uses a level-1 primary-class baseline. Equipment includes the loadout's passive effects, and Gender measures its effect after modifiers and rounding. Calculation gender is an optional saved plan input; read-only sheets show its label while editable sheets supply it through their existing calculation callback. Do not infer recorded character gender or rewrite older plans that omit it. See [the calculation package](calculations.md) for formula scope and contribution semantics.

When changing these components, verify definition inspection, native plans with and without model markers, read-only share previews and saved copies, unknown character observations, save failure retries, and desktop and mobile layouts. The sharing and character sheet browser tests cover those flows, including offline rendering and preview-to-editor calculation parity.
