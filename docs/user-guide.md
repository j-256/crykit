# User guide

Start with the [first-build walkthrough](../README.md#try-your-first-build) if you are new to Crystal Kit. This guide covers the details you can explore as you need them.

[Getting around](#getting-around) · [Builds](#create-and-save-builds) · [Teams](#check-a-team) · [Characters](#record-characters) · [Inventory and progress](#track-inventory-and-progress) · [Reference](#browse-reference-data) · [Backups](#imports-backups-and-privacy) · [Offline use](#use-the-app-offline)

## Getting around

The app opens to the build library. Builds, Teams, and Reference share the main menu. Characters, Inventory, and Progress live under Tracking. Buildcrafting works without entering a Playthrough or characters. Tracking connects plans to your observed game state when you choose to use it.

The first visit includes a labeled sample Playthrough with sample characters, their starting equipment, character sheets, reusable Builds, and an active sample team. These synthetic records are for exploring the planner. Start a new Build, create a blank Playthrough for your own tracked game, or replace all planner data with an import. Builds, Teams, and Game Setups are shared across Playthroughs. Reloading retains saved edits; clearing the browser's application data starts the sample again.

### Choose a Playthrough and Game Setup

**Game Setups** describe the game rules used for planning: base game version, difficulty, and enabled mods. Open **Builds > Game Setups** or **Data & settings > Saved setups** to create or edit a reusable setup. **Start a Build** uses the chosen setup as a starting point. Each saved checkpoint keeps its exact rules, so later edits do not change earlier plans.

The editor puts **Game version** and **Difficulty** first. **Enter exact version** accepts a version not listed. **Base game details** contains platform and mode. New setups default to **Standard** mode; opening a saved setup retains its recorded mode. **Mods** contains ordered imported revisions, with named choices under **Mods without imported files** for cases where a mod file is unavailable. A mod name alone does not establish its calculation effects. **Rules from game data** shows supported changes and coverage gaps. PP budgets and equipment layouts are not arbitrary configuration controls.

Saving creates a new setup revision. Unchanged forms cannot create duplicate revisions. **Discard changes** restores the opened revision after confirmation. Closing with unsaved changes asks whether to discard or keep editing. A failed save retains the draft for **Retry save**.

A **Playthrough** represents one tracked game save and owns characters, inventory, progress, and party plans. Its selector appears on Tracking pages. Open **Data & settings > Playthrough** to switch saves or create a blank Playthrough. A new Playthrough starts in Standard mode with unknown platform, version, and mods unless you explicitly choose an existing setup. This page displays the selected rules as a read-only summary. Choose a saved revision under **Game Setup to apply**, review its summary, then choose **Apply**. Create or edit version, difficulty, and mods under **Saved setups**. Saving a setup never applies it to a Playthrough automatically.

**Party plan** selects the tracked party used for inventory and readiness checks. **None selected** clears the selection without deleting a plan. Finish open drafts or retry failed saves before switching.

## Manage mods

Open **Mods > Editor workspace**, choose a Crystal Edit JSON file, and inspect or edit its records. Apply edits to save the working draft, then choose **Save to CryKit** to add it to **Mod library**. Saved versions are grouped by project ID; changed contents create another revision. **Edit a copy** opens an exact saved source for further editing. Select the desired revision and order under a Build's **Game Setup > Mods**. Existing checkpoints keep their mod versions.

Supported game and mod data supplies calculation constants and difficulty effects. Incomplete or unsupported changes remain visible in **Rules from game data**. The library is included in planner backups; editor drafts have separate downloads. See [Mods and the editor workspace](mod-inspector.md) for inspection, exports, and recovery.

## Create and save builds

Choose **Builds > New Build** to open a blank Build sheet. Type into class, sub-command, equipment, accessory, or passive fields and select a matching catalog or personal definition. Search text never becomes a saved selection or creates a definition. Sub-commands use documented command names while retaining the associated class identity. No recorded inventory, character, or learned skills are required.

A new Build has independent game settings. Open **Game Setup** to choose version, difficulty, and mods, or **Copy Game Setup** to use a saved setup. Changes save with the checkpoint and leave other builds and Playthroughs unchanged. Equipment uses the standard layout; passives form an ordered list. Named mod choices support Enabled, Disabled, and Unknown, while imported mods supply exact definitions and supported calculation constants.

The primary class's stat ratings appear above the loadout using the game's colored full and half stars. The same ratings appear in Reference, with source details and explicit unknown values. Class ratings describe base-stat scaling and growth; they are separate from a character's recorded stats. Set a planned level and growth history under **Checks & notes > Stats & combat estimates** to calculate numeric values. A saved calculation plan also exposes **Planned base & equipped stats** in the class stats panel; unsupported contributions and incomplete inputs remain unresolved.

### Choose equipment and passives

Equipment searches exclude identified category articles. Choices show catalog stats and effects, with full reference fields and attribution available beneath each selection. Similar spellings remain separate identities and are labeled when their relationship is unconfirmed; entries supported only by name evidence sort after detailed records.

Selected fields show definition artwork, and empty fields show their slot's role icon. Class summaries put the command name and icon first, followed by equipment permission icons; hover or focus an icon for its name. Monetary cost appears last in detailed facts and is omitted from compact field summaries. PP remains visible for passive planning. The desktop library keeps class names and equipment slots readable beside the editor; selection details appear beneath the loadout when a definition is inspected.

Equipment searches include every available definition that fits the slot. Choices known to be incompatible with the primary class and selected permission effects appear last in gray with the reason. They remain selectable for planning. Missing or conflicting equipment types and permissions stay explicitly unknown, with their normal appearance; an unrecorded inventory item is separate from an equipment permission conflict.

Passive searches label PP directly. A single default-on toggle includes innates from the Learnable Innate Skill mod across every passive search, while missing PP costs remain explicit.

Build validity sums the PP costs of every equipped passive against the pinned Game Setup's limit and reports unresolved costs separately. The PC 1.6.9 model uses the game's 10 PP budget. Imported mods can change individual passive costs; unsupported rule changes remain unresolved. The limit is a budget, not a count of passive positions or a character observation. Validation also checks documented class, equipment, slot, hand, and passive rules without depending on a character or inventory.

### Save checkpoints and make copies

**Save build** creates the Build and its first checkpoint together. Choose **Checks & notes** to find the title and notes under **Build details & notes**; an unnamed Build uses its class name. The sheet stays directly editable on desktop and mobile, and further passive rows appear as selections are added.

Choose **Rename** beside a saved Build's heading to change its title. **Save title** updates the library name without creating a checkpoint or saving unfinished loadout edits. Canceling leaves the saved name intact; leaving with an edited title offers **Save and continue** or **Discard and continue**.

Cloning makes a separate draft within the same Game Setup; editing creates a new immutable checkpoint. Builds from another Game Setup remain directly editable using their checkpoint's pinned behavior and catalog definitions.

When one equipped item occupies several slots, mark those selections as the same copy. On narrow screens the library starts collapsed and selection evidence appears directly below its field.

Optional tracking actions live under **Use with Tracking**, including character comparisons, recording, and party readiness. Readiness and recording actions follow the saved checkpoint displayed in the editor. Creating a party plan from readiness uses the saved checkpoint's Game Setup and catalog snapshot, even when the current Playthrough uses another Game Setup. Shared validation causes are grouped, with affected slots and links to the relevant records or settings.

### Explore stat estimates

The build editor also checks documented equipment permissions, hand occupancy, roles, and unique flags before a scenario exists. On **Loadout**, **Calculated stats** saves the calculation level and growth allocation with each checkpoint, defaulting to level 60 and all growth in the primary class. Untouched allocations follow the primary class and level; editing one preserves your manual allocation until explicitly reset. Numeric controls and fixed-scale sliders share one allowance. Totals show male and female bonuses separately, and sample damage benchmarks illustrate stat differences. **Export calculation package** shares the versioned formulas, constants and evidence without personal data. Older saved plans retain **Stats & combat estimates** under **Checks & notes** until explicitly switched to PC calculations. These estimates do not alter recorded character data. See [build mechanics and calculation scope](planner-mechanics.md).

Class pages and build plans offer scoped calculations with explicit inputs. Conditional battle effects, encounter simulation, optimization, and automatic game-state inspection require additional verified data.

## Share a build or team

Choose **Share build** on a build card or an open saved checkpoint, or **Share team** on a saved Team, then choose **Copy link**. Build cards share the latest checkpoint. A recipient can inspect the snapshot and choose **Save a copy**. Matching Game Setups are reused; a different setup gets a unique name if its name is already taken. Team copies save four build slots directly, without requiring tracked characters. **Include written notes** adds rotation notes, written assumptions, and checkpoint names. Build behavior and calculation inputs are always included, and character observations and inventory remain local. See [share links](share-links.md) for URL capacity, catalog requirements, and privacy.

## Check a team

Open **Teams > New Team**, name the Team, and choose a saved checkpoint for each of its four slots. The same build can appear in several slots. Empty slots can be saved while planning. Saving another build checkpoint does not change a Team's existing pins. Teams can be shared and copied independently of tracking.

To use a Team in a tracked game, open its **Use with Tracking > Adopt Team** action. Match the slots to four distinct characters in the selected Playthrough. Each slot offers a comparison of recorded equipment, classes, and passives with the proposed build. **Check party readiness and shared equipment** checks learning and simultaneous stock use. All checkpoints must use compatible Game Setups to record one party. Confirm **I applied these builds in game** before recording.

For one character, open a saved Build's **Use with Tracking > Compare / record on a character**, or choose **Compare or apply a Build** on the character page. Comparing saves nothing. Recording creates a new current snapshot and preserves history, learning, levels, and inventory. Displayed stats require recapture. No four-character party is required for a single build.

Tracking also provides **Characters > Party plans & readiness** for draft and hypothetical assignments. Alternative plans do not reserve stock. Validation distinguishes known conflicts from facts that still need confirmation. Recording a whole Team uses one transaction, so a failed save leaves every character unchanged.

## Record characters

Characters opens a roster overview with stacked game-menu cards for every character in the active Playthrough. Each card shows its current snapshot's level, primary and secondary classes, recorded stats, equipment, equipped passives, and observation date, alongside character-specific LP, mastery, and learned-skill records.

Stat names and units stay as recorded; missing HP or MP stays unknown, and current and maximum values are never assumed to be interchangeable. A known empty passive list means none are equipped, while an unknown list means the equipped passives were not recorded.

The overview follows each snapshot's pinned Game Setup revision, even when the Playthrough now uses another revision, and includes characters outside the selected party plan. **Member**, **Learn**, and **History** open the selected character directly; **Overview** returns to the roster. New characters remain blank until observations are added.

### Update a character and review history

The compact **Member** screen shows recorded vitals, class and command, equipment, and a passive strip. Select a row to update it through an anchored searchable dropdown. Desktop selection details sit beside the menu; mobile details expand beneath the selected row.

**Save changes** saves a new character snapshot without changing inventory or shared Builds. For equipment, **Empty** means nothing is equipped in that slot and **Unknown** means its contents have not been recorded. Passives use a separate ordered list with known or unknown certainty. The calculated stat panel compares resting loadout totals with recorded in-game totals. It shares the Build level and growth controls and shows neutral, male and female cases with their differences. Calculation assumptions are saved separately from observed level and stats; unknown equipment or passive observations keep totals unresolved. **Status** reveals recorded totals; **Capture snapshot** records a full observation.

Unsaved changes block navigation, and failed saves retain the draft with a retry action that persists the same observation.

History can inspect a saved snapshot or compare two exact snapshots, showing changed fields first. Numeric differences require two known values with matching stat names and units and do not imply a cause.

**Compare or apply a Build** opens a saved checkpoint for comparison with this character and lists its assignments in tracked party plans.

**Learn** combines class progress and learned-node observations, with a type filter for abilities, passives, innates, and Monster Magic. Earlier character-section links remain supported.

### Import learning screenshots

Characters also offers **Learn > Import skill screenshots** for full Learn-menu captures. It reads the character and selected class locally, skips identical decoded images, and separates gold learned squares from blue available and dim locked squares. Review each screenshot before saving.

Confirmed class position maps are available for their documented Switch mod setup. Partial maps fill only confirmed names and retain unresolved squares.

Other ability names require a reviewed position mapping for each class and Game Setup revision; the screenshots do not display those names, and the app does not guess them from catalog order. Mappings can be reused across characters. Unmapped squares remain saved observations, and conflicting learning remains explicit. See [screenshot learning imports](screenshot-learning.md) for supported images, mapping reuse, recovery, and offline behavior.

## Track inventory and progress

The inventory form starts with focus on the item picker and uses the selected item's name. Choose "Enter an unlisted item" to record something outside the list, or "Customize display name" to give a selected item a different inventory label. Clearing the optional display name or choosing "Use item name" restores the selected item's name without changing its definition.

Inventory records what you have observed about your current stock. A historical acquisition is kept separately from current stock. Party-wide progress and character learning have separate editors; neither is inferred from the other.

### Track summons

Open **Progress > Summons** to mark Summoner skills available for the active Playthrough. The board follows the game's skill-tree layout, omits the passive nodes, and labels each summon with its deity title. Pinga is the starting summon and stays gold (unlocked); its tile cannot be toggled. The other tiles start gray; click a tile to turn it gold, then click again to undo. There is no intermediate blue stage and no record of which characters learned the skills. For the other summons, defeat the deity with a Summoner in your party before marking the skill available.

Follow **Skill** or **Deity** beneath a tile to open its matching Reference page without changing its unlock state. Marks save automatically, remain separate between Playthroughs, and are included in backups. Imported unknown or conflicting unlock values show **Needs confirmation** until you choose a state. If a save fails, the tile returns to its saved state and offers **Retry summon**. The board and bundled artwork work offline after preparing the app. See [summon reference evidence](summons.md) for the source scope.

### Track travel and capability unlocks

Open **Progress > Travel & unlocks** to mark mount instruments, reusable shrine stones, and capability items acquired or not acquired for the selected Playthrough. Each tile shows a game icon and links to its attributed location and requirements in Reference. Search and filter the checklist to review what remains. Imported values that are unknown or conflicting stay unconfirmed until you choose a state. These marks save automatically and remain separate from inventory quantities and character learning.

### Follow the Golden Quintar guide

Open **Progress > Quintar breeding** for an ordered guide through nursery access, wild eggs, both breeding branches, and the Golden Quintar. Unmarked tiles have gray symbols; clicking a tile marks it complete and restores its color. Click again to undo. Instructions stay visible, and **Go to next step** takes you to the first unmarked tile. **Class seals** returns to the mastery board.

Each breeding tile shows its parents, cumulative wins on different race tracks, and which parents to keep or release after hatching. Release advice follows the displayed route only; retain quintars you need for another purpose. **Breeding tips & sources** explains happiness, nursery space, Incubators, and the community sources. The route and race requirements have unverified Switch and mod applicability.

Completion marks belong to the selected Playthrough, save automatically, and survive reloads and native backups. You can mark steps in any order; missing prerequisite marks remain visible and are never filled in automatically. Marks record completed actions without changing your inventory, nursery roster, character learning, or class seals. A failed save restores the tile's saved state and offers **Retry step**. The guide works offline after preparing the application for offline use.

## Browse reference data

A searchable, revision-attributed community reference catalog covers items, classes, abilities, passives, innates, Monster Magic, monsters, commands, statuses, recipes, and locations. Catalog presence never establishes ownership or learning. Documented facts, source conflicts, and missing details remain distinct, and Nintendo Switch or official mod-pack parity is not assumed; see [catalog sources](catalog-sources.md). Sample equipment follows the bundled class pages' initial equipment lists, while unverified rules and displayed stats remain unresolved. Additional reference files and personal records can be imported locally.

### Search and filter

Reference groups categories into equipment families, classes and skills, combat effects, world and enemy details, and mods. Search reaches every category, including imported categories and detailed source tags. Definition types are grouped by purpose; choosing a type narrows the category suggestions.

Separate class, equipment-slot, element, source-mod, source, and PP filters use recorded fields and documented associations where available. Alternatives within a filter are combined; different filters narrow results together.

Active selections remain visible above the results and can be removed individually or cleared together, including when mobile filters are closed. Filters survive details, browser navigation, and reloads. Unknown and conflicting values remain possible matches where appropriate; missing facts are not inferred from names or descriptions.

Opening a definition uses the full content width. Short facts share columns, while tables and longer descriptions have their labels above them and span the page. Source details follow the facts. On narrow screens, wide tables scroll within their own area. **Back to results** returns to the retained search and filters. Catalog and personal definitions use the same layout.

### Find weapon skills

To browse weapon skills, choose **Reference > Weapon skills > Weapon skills usable with > Dagger**, or press Cmd+K / Ctrl+K, type **dagger**, and open **Skills usable with Dagger**. On mobile, open **Filters** first. Results include multi-weapon and any-weapon skills, with class, listed weapon requirements, and cost visible. Spells and ordinary abilities are excluded. Unknown or conflicting requirements are available through an explicit checkbox. Filters survive details, reloads, and browser navigation. An explicitly enabled **Unrestricted Weapon Skills** mod broadens the list while retaining the original requirements. Other mod visibility follows the current Game Setup.

### Configure mods and import custom classes

Choose **Enabled**, **Disabled**, or **Unknown** for each named mod in the Game Setup editor. Open **Data & settings > Saved setups > Edit setup** for reusable planning rules, then **Playthrough > Game Setup to apply** to use the saved revision for a tracked game. The fixed Switch list is grouped by the two official packs. Known mod associations control definition searches and choices; unclassified entries stay visible. Character sheets retain their pinned Game Setup revision, including mod settings. See [playthrough mods](mods.md) for supported filtering and catalog gaps.

Brawler and its class skills are associated with **Moonlight Project**. Their mod badges and availability follow that entry's recorded setting. The Monk's base-game Brawler passive is a separate definition.

Vanilla class ratings, equipment permissions, and learn trees ship with the app, extracted directly from the game's database. Class details include a growth calculator, and the modding guide provides searchable modifier references. Crystal Edit `mod.json` imports support custom classes and vanilla edits without replacing personal records. See [Class data, Crystal Edit imports, and growth estimates](crystal-edit.md).

### Correct or extend reference entries

Use **Edit reference** to correct facts directly on the page, then collect and export a delta from **Corrections**. Evidence and game context can be added incrementally. See [corrections and baseline review](corrections.md) for local persistence, submission, and immutable catalog promotion.

Definition fields open compact searchable dropdowns beside the selected field. Choices include descriptions, source labels, and relevant stock or PP details. The surrounding form stays usable, and dropdowns fit the available space above or below their field. Search receives focus on opening; arrow keys browse choices, Enter selects, and Escape returns to the field.

Creation and editing use centered dialogs with a dim, unblurred backdrop. An outside click closes the dropdown first; unsaved-draft checks still apply to editing dialogs.

An edit saves a separate personal override and preserves its source and earlier revisions. Ownership and learning follow the underlying identity; saved Builds retain their exact definitions. Reference can collect reviewed personal definitions into a new Game Setup revision without changing the Playthrough's current Game Setup or existing selections.

## Search, drafts, and bookmarks

Press Cmd+K on macOS or Ctrl+K elsewhere, or use the visible search button, to search definitions, inventory, characters, builds, teams, and progress. Arrow keys move through results, Enter opens one, and Escape closes the search. Open forms must be finished before navigating to another record.

Build drafts can remain open while browsing Reference in the same tab; use **Return to build draft** or the Builds navigation button to resume selections, title, and notes. Save before reloading or closing the tab. Other navigation, context changes, and failed saves retain their draft guards.

Pages, record details, settings sections, and modal workflows have semantic URLs. Copy the address bar to bookmark the selected view or reopen a dialog. Browser Back and Forward follow the same navigation, including nested definition pickers and editors. See [navigation and local links](navigation.md) for refresh, draft, and missing-data behavior.

A copied link opens a view; it does not transfer your saved records to another browser. Use a backup to move the data too.

## Imports, backups, and privacy

Save open forms, then choose **Data & settings > Import & backup > Export backup**. The backup includes all Playthroughs, Game Setups, Builds, saved records, and reference correction history. Keep a copy outside your browser.

To restore on another browser or device, open **Data & settings > Import & backup** and select the backup under **Import or restore**. Review the preview before confirming. A native restore replaces all local planner data in that browser; it does not merge two sets of records.

Use Data & settings to preview a local reference workbook, supported research JSON/package, or native backup before importing it. Reference definitions do not establish ownership, learning, or mastery. A historical acquisition is preserved separately from current stock. Unsupported or conflicting mechanics remain unresolved.

The application makes no automatic requests for game data and has no login, telemetry, remote fonts, or cloud synchronization. Personal files stay in browser storage unless explicitly exported. Native backups can contain private notes and source records; handle them as personal files. A native restore replaces the local planner-data root after confirmation, while separate save lineages belong in Playthroughs inside that root.

See [local data and interchange](data-formats.md) for supported inputs, backup structure, planner-data replacement behavior, and recovery boundaries.

## Use the app offline

While connected, open **Data & settings > Offline & storage**. If the app is not ready, choose **Prepare for offline use** and wait for **Offline ready** before relying on it without a connection. Offline preparation caches the application and its bundled reference data. The first download can take time on a slow connection; preparation stays in progress until installation completes. If installation fails, reconnect and retry. Keep exporting backups for your personal records.

When an update is available, save open drafts and choose **Apply app update** in the same section. Updates wait for your approval.

Updates retain the active and previous offline builds, pruning older caches from the same installation. An update never forces other tabs to reload. Reload older tabs after saving their drafts to pick up the active build; IndexedDB records are separate from these caches.

Offline use requires the hosted app or a [local production build](development.md#preview-the-production-app). Development mode does not install an offline service worker.
