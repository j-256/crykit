# Crystal Companion

[Open the app](https://crycom.lasers.app/) · [Credits & licenses](https://crycom.lasers.app/#/settings/credits) · [Report a problem](https://github.com/j-256/crystal-companion/issues)

A local-first inventory, character, and party planner for Crystal Project. Personal records live in the browser and move between devices through explicit file backups. The application does not connect to the game or infer unrecorded possessions, mastery, or combat rules.

The first visit starts with a labeled sample playthrough: Rowan the Warrior and Mira the Cleric, their starting equipment, character sheets, editable builds, and an active sample team. These synthetic records are for exploring the planner. Replace them with your observations, create a blank profile in Data & settings, or import a playthrough. Reloading retains saved edits; clearing the browser's application data starts the sample again.

A searchable, revision-attributed community reference catalog covers items, classes, abilities, passives, innates, Monster Magic, monsters, commands, statuses, recipes, and locations. Catalog presence never establishes ownership or learning. Documented facts, source conflicts, and missing details remain distinct, and Nintendo Switch or official mod-pack parity is not assumed; see [catalog sources](docs/catalog-sources.md). Sample equipment follows the bundled class pages' initial equipment lists, while unverified rules, PP capacity, and displayed stats remain unresolved. Additional reference files and personal records can be imported locally.

Vanilla class ratings, equipment permissions, and exported learn trees ship with the app, using a baseline assumed to match the game release at export. Class details include a growth calculator, and the modding guide provides searchable modifier references. Crystal Edit `mod.json` imports support custom classes and vanilla edits without replacing personal records. See [Crystal Edit data and growth estimates](docs/crystal-edit.md).

Development and verification can run entirely locally. The public repository also verifies changes and deploys main with GitHub Actions. Actions must remain disabled whenever the repository is private; the workflow retains a public-repository guard.

The interface takes its visual cues from Crystal Project's menus: charcoal windows, silver borders, cyan dividers, blue selections, and pixel headings. [Pixel Operator](https://www.dafont.com/pixel-operator.font) by Jayvee Enaguas is a readable substitute for the game's lettering, not a verified match to its original typeface. It ships locally under [CC0](public/pixel-operator-CC0.txt), with regular weight, disabled ligatures, and fixed type sizes. Body text and compact section headings use system fonts for readable descriptions and forms. The original crystal artwork and menu icons ship with the app; decorative artwork does not represent recorded inventory or game progress. Reference entries also show locally bundled wiki sprites and icons where an explicit source mapping exists, with per-file attribution and separate [artwork rights and refresh instructions](docs/catalog-sources.md#sprite-and-icon-snapshot).

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

Use **Edit reference** to correct facts directly on the page, then collect and export a delta from **Corrections**. Evidence and game context can be added incrementally. See [corrections and baseline review](docs/corrections.md) for local persistence, submission, and immutable catalog promotion.

The application makes no automatic requests for game data and has no login, telemetry, remote fonts, or cloud synchronization. Personal files stay in browser storage unless explicitly exported. Native backups can contain private notes and source records; handle them as personal files. A restored copy can remain a separate playthrough instead of overwriting another device's work.

Original workbooks, trackers, personal exports, and private screenshots do not belong in this repository. Commit hooks check staged content for common private artifacts, credentials, machine paths, and unreviewed workflow files. These checks support human review; they do not certify data rights or detect every possible private fact.

## Plan a party

Use the **Playthrough**, **Ruleset**, and **Scenario** dropdowns at the top to switch local context. Each supports search and keyboard selection on desktop and mobile. Playthrough switches open the destination's list with that profile's records. Ruleset choices affect new plans and definition filtering; saved builds and scenarios retain their pinned revisions. Scenario choices show each team's ruleset, keep the active ruleset unchanged, and prioritize the selected team for readiness checks when a build belongs to several teams. **None selected** clears the active scenario without deleting it. Finish open drafts or retry failed saves before switching; management actions lead to profile settings, ruleset configuration, and team scenarios.

Choose **Builds & teams > New build** to open a blank character sheet. Type into class, sub-command, equipment, accessory, or passive fields and select a matching catalog or personal definition. Search text never becomes a saved selection or creates a definition. Sub-commands use documented command names while retaining the associated class identity. No recorded inventory, character, or learned skills are required. A suggested slot layout is available when the playthrough has no configured slots; its game rules remain unknown and its slots can be adjusted in Data & settings. Existing configured layouts are preserved.

Equipment searches exclude identified category articles. Choices show source stats and effects, with full reference fields and attribution available beneath each selection. Similar spellings remain separate identities and are labeled when their relationship is unconfirmed; entries supported only by name evidence sort after detailed records. Passive searches label source PP explicitly, and innate effects require an explicit inclusion toggle because their eligibility remains unverified. The PP summary separates known source costs from unresolved costs and lets you inspect a character's recorded capacity without treating it as proof for the planned configuration.

Save build creates the build and its first checkpoint together. Title, optional character binding, and notes are under **Build details & notes**; an unnamed build uses its class name. The sheet stays directly editable on desktop and mobile, and further passive rows appear as selections are added. Cloning makes a separate draft; editing a checkpoint creates a new immutable revision. When one equipped item occupies several slots, mark those selections as the same copy. On narrow screens the library starts collapsed and selection evidence appears directly below its field. In-game readiness is a separate, collapsed check with adjacent character and scenario assignment. Readiness and recording actions follow the saved checkpoint displayed in the editor. Creating a scenario from readiness uses the saved revision's ruleset and catalog snapshot, even when the active ruleset differs. Shared validation causes are grouped, with affected slots and links to the relevant records or settings.

Characters opens a roster overview with stacked game-menu cards for every character in the active playthrough. Each card shows its current snapshot's level, primary and secondary classes, recorded stats, equipment, equipped passives, and observation date, alongside character-specific LP, mastery, and learned-skill records. Stat names and units stay as recorded; missing HP or MP stays unknown, and current and maximum values are never assumed to be interchangeable. Empty and unknown passive slots have distinct counts in an expandable summary. The overview follows each snapshot's saved slot context, even when the active ruleset differs, and includes characters outside the selected team scenario. **Member**, **Learn**, and **History** open the selected character directly; **Overview** returns to the roster. New characters remain blank until observations are added.

The compact **Member** screen shows recorded vitals, class and command, equipment, and a passive strip. Select a row to update it through an anchored searchable dropdown. Desktop selection details sit beside the menu; mobile details expand beneath the selected row. **Save changes** saves a new character snapshot without changing inventory or planned builds. **Empty** means nothing is equipped in that slot; **Unknown** means its contents have not been recorded. Displayed stats remain recorded values rather than recalculations. **Status** reveals recorded totals; **Capture snapshot** records a full observation. Unsaved changes block navigation, and failed saves retain the draft with a retry action that persists the same observation. History can inspect a saved snapshot or compare two exact snapshots, showing changed fields first. Numeric differences require two known values with matching stat names and units and do not imply a cause. Character-bound draft and hypothetical builds are under **Planned builds** and link back to Builds & teams, where proposal revision history remains separate. **Learn** combines class progress and skill observations, with a type filter for abilities, passives, innates, and Monster Magic. Earlier character-section links remain supported.

Assign checkpoints to a team scenario to check simultaneous stock, learning, PP, equipment permissions, and source applicability. Alternative library builds do not reserve stock. Each dimension reports proved issues separately from facts that still need confirmation. Recording a build as current requires an explicit in-game confirmation and preserves the previous character snapshots.

The build editor also checks documented equipment permissions, hand occupancy, roles, and unique flags before a scenario exists. **Stats & combat estimates** saves explicit growth plans, bonuses, statuses, and ability-preview inputs with each checkpoint. It shows supported stat contributions, derived estimates, and source costs, with conflicting values and excluded effects visible. These estimates do not alter recorded character data. See [build mechanics and calculation scope](docs/planner-mechanics.md).

Definition fields open compact searchable dropdowns beside the selected field. Choices include descriptions, source labels, and relevant stock or PP details. The surrounding form stays usable, and dropdowns fit the available space above or below their field. Search receives focus on opening; arrow keys browse choices, Enter selects, and Escape returns to the field. Creation and editing use centered dialogs with a dim, unblurred backdrop. An outside click closes the dropdown first; unsaved-draft checks still apply to editing dialogs. An edit saves a separate personal override and preserves its source and earlier revisions. Ownership and learning follow the underlying identity; saved builds retain their exact definitions. Reference can collect reviewed personal definitions into a new ruleset revision without changing the active ruleset or existing selections.

The inventory form starts with focus on the item picker and uses the selected item's name. Choose "Enter an unlisted item" to record something outside the list, or "Customize display name" to give a selected item a different inventory label. Clearing the optional display name or choosing "Use item name" restores the selected item's name without changing its definition.

Press Cmd+K on macOS or Ctrl+K elsewhere, or use the visible search button, to search definitions, inventory, characters, builds, teams, and progress. Arrow keys move through results, Enter opens one, and Escape closes the search. Open forms must be finished before navigating to another record. Build drafts can remain open while browsing Reference in the same tab; use **Return to build draft** or the Builds navigation button to resume selections, title, and notes. Save before reloading or closing the tab. Other navigation, context changes, and failed saves retain their draft guards.

To browse weapon skills, choose **Reference > Weapon skills > Weapon skills usable with > Dagger**, or press Cmd+K / Ctrl+K, type **dagger**, and open **Skills usable with Dagger**. On mobile, open **Filters** first. Results include multi-weapon and any-weapon skills, with class, listed weapon requirements, and cost visible. Spells and ordinary abilities are excluded. Unknown or conflicting requirements are available through an explicit checkbox. Filters survive details, reloads, and browser navigation. An explicitly enabled **Unrestricted Weapon Skills** mod broadens the list while retaining the original requirements. Other mod visibility follows the active ruleset.

Reference groups categories into equipment families, classes and skills, combat effects, world and enemy details, and mods. Search reaches every category, including imported categories and detailed source tags. Definition types are grouped by purpose; choosing a type narrows the category suggestions. Separate class, equipment-slot, element, source-mod, source, and PP filters use recorded fields and documented associations where available. Alternatives within a filter are combined; different filters narrow results together. Active selections remain visible above the results and can be removed individually or cleared together, including when mobile filters are closed. Filters survive details, browser navigation, and reloads. Unknown and conflicting values remain possible matches where appropriate; missing facts are not inferred from names or descriptions. Party-wide progress and character learning have separate editors; neither is inferred from the other.

Choose **Enabled**, **Disabled**, or **Unknown** for each mod in **Data & settings > Ruleset**. The fixed Switch list is grouped by the two official packs. Known mod associations control definition searches and choices; unclassified entries stay visible. Character sheets retain their recorded ruleset context, including mod settings. See [playthrough mods](docs/mods.md) for supported filtering and catalog gaps.

Characters also offers **Learn > Import skill screenshots** for full Learn-menu captures. It reads the character and selected class locally, skips identical decoded images, and separates gold learned squares from blue available and dim locked squares. Review each screenshot before saving. Confirmed class position maps are available for their documented Switch mod setup. Partial maps fill only confirmed names and retain unresolved squares. Other ability names require a reviewed position mapping for each class and ruleset; the screenshots do not display those names, and the app does not guess them from catalog order. Mappings can be reused across characters. Unmapped squares remain saved observations, and conflicting learning remains explicit. See [screenshot learning imports](docs/screenshot-learning.md) for supported images, mapping reuse, recovery, and offline behavior.

Pages, record details, settings sections, and modal workflows have semantic URLs. Copy the address bar to bookmark the selected view or reopen a dialog. Browser Back and Forward follow the same navigation, including nested definition pickers and editors. See [navigation and local links](docs/navigation.md) for refresh, draft, and missing-data behavior.

## Verification

Checks run on the local machine:

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run verify` runs both groups. Browser tests use the production build and include desktop and mobile emulation. They do not establish physical-device installation or verify a phone's native file picker.

The [revision 2 specification](docs/spec-v2.md) defines data boundaries, core workflows, and acceptance gates. Class pages and build plans offer scoped estimates with explicit inputs. Full displayed-stat prediction, final enemy-damage simulation, optimization, and automatic game-state inspection require additional verified data.

## Static hosting

Serve `dist/` from a secure origin. Hash routes and relative asset URLs support a subdirectory. Offline preparation requires HTTPS or a browser's trusted localhost context. Prepare the production app while connected, then check its offline status before relying on it without a connection. App updates are staged for explicit activation; browser storage still needs external backups.

The hosted app uses an assets-only Cloudflare Worker at `crycom.lasers.app`. The aliases `cp.lasers.app` and `crystal.lasers.app` use HTTP 307 redirects that preserve the request method, path, and query. See [deployment and recovery](docs/deployment.md) for configuration, the public-only CI sequence, and Free-plan limits. Local builds do not need Cloudflare credentials.

Updates retain the active and previous offline builds, pruning older caches from the same installation. An update never forces other tabs to reload. Reload older tabs after saving their drafts to pick up the active build; IndexedDB records are separate from these caches.

## License

Original application code is licensed under [AGPL-3.0-only](LICENSE). Game artwork, wiki content, fonts, and dependencies retain their separate rights and credits in [NOTICE.md](NOTICE.md) and **Data & settings > Credits & licenses**. Crystal Companion did not create the game sprites or wiki images. Crystal Project belongs to its respective creators; this is an independent, unofficial fan tool.

Use [GitHub issues](https://github.com/j-256/crystal-companion/issues) for bugs, source corrections, and attribution concerns. Include reproducible steps and synthetic examples; do not upload personal backups, imports, or playthrough screenshots to a public issue.
