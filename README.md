# Crystal Companion

A local-first inventory, character, and party planner for Crystal Project. Personal records live in the browser and move between devices through explicit file backups. The application does not connect to the game or infer unrecorded possessions, mastery, or combat rules.

The application starts with a blank playthrough and a searchable, revision-attributed community reference catalog covering items, classes, abilities, passives, innates, Monster Magic, monsters, commands, statuses, recipes, and locations. Catalog presence never establishes ownership or learning. Documented facts, source conflicts, and missing details remain distinct, and Nintendo Switch or official mod-pack parity is not assumed; see [catalog sources](docs/catalog-sources.md). Additional reference files and personal records can be imported locally.

Development and verification run locally. GitHub Actions is disabled for this repository, and no workflow should be enabled without an explicit maintainer request.

The interface takes its visual cues from Crystal Project's menus: charcoal windows, silver borders, cyan dividers, blue selections, and pixel headings. [Pixel Operator](https://www.dafont.com/pixel-operator.font) by Jayvee Enaguas is a readable substitute for the game's lettering, not a verified match to its original typeface. It ships locally under [CC0](public/pixel-operator-CC0.txt), with regular weight, disabled ligatures, and fixed type sizes. Body text and compact section headings use system fonts for readable descriptions and forms. The original crystal artwork and menu icons ship with the app; decorative artwork does not represent recorded inventory or game progress.

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

Choose **Builds & teams > New build** to open a blank character sheet. Type into class, sub-command, equipment, accessory, or passive fields and select a matching catalog or personal definition. Search text never becomes a saved selection or creates a definition. Sub-commands use documented command names while retaining the associated class identity. No recorded inventory, character, or learned skills are required. A suggested slot layout is available when the playthrough has no configured slots; its game rules remain unknown and its slots can be adjusted in Data & settings. Existing configured layouts are preserved.

Save build creates the build and its first checkpoint together. Title, optional character binding, and notes are under **Build details & notes**; an unnamed build uses its class name. The sheet stays directly editable on desktop and mobile, and further passive rows appear as selections are added. Cloning makes a separate draft; editing a checkpoint creates a new immutable revision. When one equipped item occupies several slots, mark those selections as the same copy. In-game readiness is a separate, collapsed check and is evaluated in a team scenario.

Characters shows the latest recorded sheet with displayed stats beside equipment on desktop and compact rows on mobile. Slot actions open a new snapshot at that selection's picker; saving appends an observation. History can inspect a saved snapshot or compare two exact snapshots, showing changed fields first. Numeric differences require two known values with matching stat names and units and do not imply a cause. Character-bound draft and hypothetical builds link back to Builds & teams, where proposal revision history remains separate.

Assign checkpoints to a team scenario to check simultaneous stock, learning, PP, equipment permissions, and source applicability. Alternative library builds do not reserve stock. Each dimension reports proved issues separately from facts that still need confirmation. Recording a build as current requires an explicit in-game confirmation and preserves the previous character snapshots.

Definition fields open compact searchable dropdowns beside the selected field. Choices include descriptions, source labels, and relevant stock or PP details. The surrounding form stays usable, and dropdowns fit the available space above or below their field. Search receives focus on opening; arrow keys browse choices, Enter selects, and Escape returns to the field. Creation and editing use centered dialogs with a dim, unblurred backdrop. An outside click closes the dropdown first; unsaved-draft checks still apply to editing dialogs. An edit saves a separate personal override and preserves its source and earlier revisions. Ownership and learning follow the underlying identity; saved builds retain their exact definitions. Reference can collect reviewed personal definitions into a new ruleset revision without changing the active ruleset or existing selections.

The inventory form starts with focus on the item picker and uses the selected item's name. Choose "Enter an unlisted item" to record something outside the list, or "Customize display name" to give a selected item a different inventory label. Clearing the optional display name or choosing "Use item name" restores the selected item's name without changing its definition.

Press Cmd+K on macOS or Ctrl+K elsewhere, or use the visible search button, to search definitions, inventory, characters, builds, teams, and progress. Arrow keys move through results, Enter opens one, and Escape closes the search. Open forms and unsaved build edits must be finished before navigating to another record.

To browse weapon skills, choose **Reference > Weapon skills usable with > Dagger**, or press Cmd+K / Ctrl+K, type **dagger**, and open **Skills usable with Dagger**. Results include multi-weapon and any-weapon skills, with class, listed weapon requirements, and cost visible. Spells and ordinary abilities are excluded. Unknown or conflicting requirements are available through an explicit checkbox. Filters survive details, reloads, and browser navigation. An explicitly enabled **Unrestricted Weapon Skills** mod broadens the list while retaining the original requirements. Other mod visibility follows the active ruleset.

Reference search also supports type, category, source, and PP filters. Unknown values remain possible matches where appropriate. Party-wide progress and character learning have separate editors; neither is inferred from the other.

Choose **Enabled**, **Disabled**, or **Unknown** for each mod in **Data & settings > Ruleset**. The fixed Switch list is grouped by the two official packs. Known mod associations control definition searches and choices; unclassified entries stay visible. Character sheets retain their recorded ruleset context, including mod settings. See [playthrough mods](docs/mods.md) for supported filtering and catalog gaps.

Characters also offers **Import skill screenshots** for full Learn-menu captures. It reads the character and selected class locally, skips identical decoded images, and separates gold learned squares from blue available and dim locked squares. Review each screenshot before saving. Confirmed class position maps are available for their documented Switch mod setup. Partial maps fill only confirmed names and retain unresolved squares. Other ability names require a reviewed position mapping for each class and ruleset; the screenshots do not display those names, and the app does not guess them from catalog order. Mappings can be reused across characters. Unmapped squares remain saved observations, and conflicting learning remains explicit. See [screenshot learning imports](docs/screenshot-learning.md) for supported images, mapping reuse, recovery, and offline behavior.

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
