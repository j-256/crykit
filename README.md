# Crystal Companion

A local-first inventory, character, and party planner for Crystal Project. Personal records live in the browser and move between devices through explicit file backups. The application does not connect to the game or infer unrecorded possessions, mastery, or combat rules.

The application starts with a blank playthrough and a searchable, revision-attributed community reference catalog covering items, classes, abilities, passives, innates, Monster Magic, monsters, commands, statuses, recipes, and locations. Catalog presence never establishes ownership or learning. Documented facts, source conflicts, and missing details remain distinct, and Nintendo Switch or official mod-pack parity is not assumed; see [catalog sources](docs/catalog-sources.md). Additional reference files and personal records can be imported locally.

Development and verification run locally. GitHub Actions is disabled for this repository, and no workflow should be enabled without an explicit maintainer request.

## Run locally

Use Node.js 22.12 or later and npm. Install from the lockfile:

```sh
npm ci
npm run hooks:install
npm run dev
```

For the production application, including offline caching:

```sh
npm run build
npm run preview
```

Open the localhost address printed by Vite. Keep using the same origin when entering real records: scheme, host, and port determine which browser database is opened. Export a backup before changing origins or clearing browser storage. Development mode does not install an offline service worker.

## Data and privacy

Use Data & settings to preview a local reference workbook, supported research JSON/package, or native backup before importing it. Reference definitions do not establish ownership, learning, or mastery. A historical acquisition is preserved separately from current stock. Unsupported or conflicting mechanics remain unresolved.

See [local data and interchange](docs/data-formats.md) for supported inputs, backup structure, profile restore behavior, and recovery boundaries.

The application makes no automatic requests for game data and has no login, telemetry, remote fonts, or cloud synchronization. Personal files stay in browser storage unless explicitly exported. Native backups can contain private notes and source records; handle them as personal files. A restored copy can remain a separate playthrough instead of overwriting another device's work.

Original workbooks, trackers, personal exports, and private screenshots do not belong in this repository. Commit hooks check staged content for common private artifacts, credentials, machine paths, and workflow files. These checks support human review; they do not certify data rights or detect every possible private fact.

## Plan a party

Record current inventory and character observations, then configure the playthrough's ruleset and ordered slots in Data & settings. Create character builds or reusable templates, choose exact reference definitions, and save named checkpoints. Cloning makes a separate draft; editing a checkpoint creates a new immutable revision. When one equipped item occupies several slots, mark those selections as the same copy.

Assign checkpoints to a team scenario to check simultaneous stock, learning, PP, equipment permissions, and source applicability. Alternative library builds do not reserve stock. Each dimension reports proved issues separately from facts that still need confirmation. Recording a build as current requires an explicit in-game confirmation and preserves the previous character snapshots.

Definition fields open searchable pickers with inline creation and editing. An edit saves a separate personal override and preserves its source and earlier revisions. Ownership and learning follow the underlying identity; saved builds retain their exact definitions. Reference can collect reviewed personal definitions into a new ruleset revision without changing the active ruleset or existing selections.

Press Cmd+K on macOS or Ctrl+K elsewhere, or use the visible search button, to search definitions, inventory, characters, builds, teams, and progress. Arrow keys move through results, Enter opens one, and Escape closes the search. Open forms and unsaved build edits must be finished before navigating to another record.

Reference search supports type, category, source, and PP filters. Unknown values remain possible matches where appropriate. Party-wide progress and character learning have separate editors; neither is inferred from the other.

Pages, record details, settings sections, and modal workflows have semantic URLs. Copy the address bar to bookmark the selected view or reopen a dialog. Browser Back and Forward follow the same navigation, including nested definition pickers and editors. See [navigation and local links](docs/navigation.md) for refresh, draft, and missing-data behavior.

## Verification

Checks run on the local machine:

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run verify` runs both groups. Browser tests use the production build and include desktop and mobile emulation. They do not establish physical-device installation or verify a phone's native file picker.

The [revision 2 specification](docs/spec-v2.md) defines data boundaries, core workflows, and acceptance gates. Formula simulation, displayed-stat prediction, optimization, and automatic game-state inspection require additional verified data and are outside the descriptive planner.

## Static hosting

Serve `dist/` from a secure origin. Hash routes and relative asset URLs support a subdirectory. Offline preparation requires HTTPS or a browser's trusted localhost context. Prepare the production app while connected, then check its offline status before relying on it without a connection. App updates are staged for explicit activation; browser storage still needs external backups.

No deployment service or hosted runner is required. Do not enable GitHub Actions or add an active workflow without an explicit maintainer request. Public hosting and redistribution of reference packs require their own review.

## License

Application code is licensed under AGPL-3.0-only. Imported reference material remains subject to its own rights and attribution requirements. Crystal Project belongs to its respective creators; this is an independent fan tool.
