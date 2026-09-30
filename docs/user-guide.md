# User guide

Start with the [first-build walkthrough](../README.md#try-your-first-build) if you are new to Crystal Companion. This guide covers the details you can explore as you need them.

[Getting around](#getting-around) · [Builds](#create-and-save-builds) · [Teams](#check-a-team) · [Characters](#record-characters) · [Inventory and progress](#track-inventory-and-progress) · [Reference](#browse-reference-data) · [Backups](#imports-backups-and-privacy) · [Offline use](#use-the-app-offline)

## Getting around

The app opens to the build library. Builds, Characters, and Reference share the main menu, with Inventory and Progress under Tracking. Create reusable builds without recording a character, owned equipment, or progress. Characters connects plans to observed in-game state when you want that context. Team scenarios and build comparisons remain within Builds.

The first visit includes a labeled sample Playthrough with sample characters, their starting equipment, character sheets, reusable Builds, and an active sample team. These synthetic records are for exploring the planner. Start a new Build, create a blank Playthrough for your own tracked game, or replace all planner data with an import. Builds and Game Setups are shared across Playthroughs. Reloading retains saved edits; clearing the browser's application data starts the sample again.

### Choose a Playthrough and Game Setup

Use **Playthrough** and **Game Setup** at the top to switch context. A Playthrough is one save lineage and owns tracked characters, inventory, progress, and scenarios.

Game Setups describe shared, versioned game configuration such as platform, mods, slots, and PP rules. Platform and game mode use finite choices; game version reuses recorded values or accepts an explicitly entered exact version.

Builds are shared across Playthroughs but belong to one logical Game Setup, and each Build checkpoint pins an exact Game Setup revision. Builds for another Game Setup remain visible at the bottom of the library in a muted group with an explanation; inspect them there or fork one into the current Game Setup.

**Scenario** appears on tracking pages, Characters, and team views. It prioritizes a selected team for readiness checks without changing the Playthrough's current Game Setup. **None selected** clears the active scenario without deleting it. Finish open drafts or retry failed saves before switching.

## Create and save builds

Choose **Builds > New Build** to open a blank Build sheet. Type into class, sub-command, equipment, accessory, or passive fields and select a matching catalog or personal definition. Search text never becomes a saved selection or creates a definition. Sub-commands use documented command names while retaining the associated class identity. No recorded inventory, character, or learned skills are required.

A suggested equipment-slot layout is available when the current Game Setup has no configured slots; its game rules remain unknown and its slots can be adjusted in Data & settings. Passives are an ordered, variable-length list rather than configured slots. Existing configured layouts are preserved.

### Choose equipment and passives

Equipment searches exclude identified category articles. Choices show catalog stats and effects, with full reference fields and attribution available beneath each selection. Similar spellings remain separate identities and are labeled when their relationship is unconfirmed; entries supported only by name evidence sort after detailed records.

Passive searches label PP directly. A single default-on toggle includes innates from the Learnable Innate Skill mod across every passive search, while missing PP costs remain explicit.

Build validity sums the PP costs of every equipped passive against the pinned Game Setup's limit and reports unresolved costs separately. The unmodified game uses a 10 PP limit; modded Game Setups can override it. The limit is a budget, not a count of passive positions or a character observation. Validation also checks documented class, equipment, slot, hand, and passive rules without depending on a character or inventory.

### Save checkpoints and make copies

**Save build** creates the Build and its first checkpoint together. Choose **Checks & notes** to find the title and notes under **Build details & notes**; an unnamed Build uses its class name. The sheet stays directly editable on desktop and mobile, and further passive rows appear as selections are added.

Cloning makes a separate draft within the same Game Setup; editing creates a new immutable checkpoint. A Build from another Game Setup is inspect-only until it is forked into the current Game Setup.

When one equipped item occupies several slots, mark those selections as the same copy. On narrow screens the library starts collapsed and selection evidence appears directly below its field.

In-game readiness is a separate, collapsed check with adjacent character and scenario assignment. Readiness and recording actions follow the saved checkpoint displayed in the editor. Creating a scenario from readiness uses the saved checkpoint's Game Setup and catalog snapshot, even when the current Playthrough uses another Game Setup. Shared validation causes are grouped, with affected slots and links to the relevant records or settings.

### Explore stat estimates

The build editor also checks documented equipment permissions, hand occupancy, roles, and unique flags before a scenario exists. Under **Checks & notes**, **Stats & combat estimates** saves explicit growth plans, bonuses, statuses, and ability-preview inputs with each checkpoint. It shows supported stat contributions, derived estimates, and source costs, with conflicting values and excluded effects visible. These estimates do not alter recorded character data. See [build mechanics and calculation scope](planner-mechanics.md).

Class pages and build plans offer scoped estimates with explicit inputs. Full displayed-stat prediction, final enemy-damage simulation, optimization, and automatic game-state inspection require additional verified data.

## Check a team

Assign checkpoints to a team scenario under **Can I use this Build now?** to check current stock, character learning and unlocks, simultaneous party conflicts, and source applicability. Passive PP legality uses the scenario's pinned Game Setup rather than a character observation. Alternative library Builds do not reserve stock. Each dimension reports proved issues separately from facts that still need confirmation.

Open **Can I use this Build now? > Record as current** to record a Build as applied in game. This requires an explicit in-game confirmation and preserves the previous character snapshots.

## Record characters

Characters opens a roster overview with stacked game-menu cards for every character in the active Playthrough. Each card shows its current snapshot's level, primary and secondary classes, recorded stats, equipment, equipped passives, and observation date, alongside character-specific LP, mastery, and learned-skill records.

Stat names and units stay as recorded; missing HP or MP stays unknown, and current and maximum values are never assumed to be interchangeable. A known empty passive list means none are equipped, while an unknown list means the equipped passives were not recorded.

The overview follows each snapshot's pinned Game Setup revision, even when the Playthrough now uses another revision, and includes characters outside the selected team scenario. **Member**, **Learn**, and **History** open the selected character directly; **Overview** returns to the roster. New characters remain blank until observations are added.

### Update a character and review history

The compact **Member** screen shows recorded vitals, class and command, equipment, and a passive strip. Select a row to update it through an anchored searchable dropdown. Desktop selection details sit beside the menu; mobile details expand beneath the selected row.

**Save changes** saves a new character snapshot without changing inventory or shared Builds. For equipment, **Empty** means nothing is equipped in that slot and **Unknown** means its contents have not been recorded. Passives use a separate ordered list with known or unknown certainty. Displayed stats remain recorded values rather than recalculations. **Status** reveals recorded totals; **Capture snapshot** records a full observation.

Unsaved changes block navigation, and failed saves retain the draft with a retry action that persists the same observation.

History can inspect a saved snapshot or compare two exact snapshots, showing changed fields first. Numeric differences require two known values with matching stat names and units and do not imply a cause.

**Build assignments** lists the shared Builds assigned to this character in the current Playthrough's team scenarios and links back to Builds.

**Learn** combines class progress and learned-node observations, with a type filter for abilities, passives, innates, and Monster Magic. Earlier character-section links remain supported.

### Import learning screenshots

Characters also offers **Learn > Import skill screenshots** for full Learn-menu captures. It reads the character and selected class locally, skips identical decoded images, and separates gold learned squares from blue available and dim locked squares. Review each screenshot before saving.

Confirmed class position maps are available for their documented Switch mod setup. Partial maps fill only confirmed names and retain unresolved squares.

Other ability names require a reviewed position mapping for each class and Game Setup revision; the screenshots do not display those names, and the app does not guess them from catalog order. Mappings can be reused across characters. Unmapped squares remain saved observations, and conflicting learning remains explicit. See [screenshot learning imports](screenshot-learning.md) for supported images, mapping reuse, recovery, and offline behavior.

## Track inventory and progress

The inventory form starts with focus on the item picker and uses the selected item's name. Choose "Enter an unlisted item" to record something outside the list, or "Customize display name" to give a selected item a different inventory label. Clearing the optional display name or choosing "Use item name" restores the selected item's name without changing its definition.

Inventory records what you have observed about your current stock. A historical acquisition is kept separately from current stock. Party-wide progress and character learning have separate editors; neither is inferred from the other.

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

### Find weapon skills

To browse weapon skills, choose **Reference > Weapon skills > Weapon skills usable with > Dagger**, or press Cmd+K / Ctrl+K, type **dagger**, and open **Skills usable with Dagger**. On mobile, open **Filters** first. Results include multi-weapon and any-weapon skills, with class, listed weapon requirements, and cost visible. Spells and ordinary abilities are excluded. Unknown or conflicting requirements are available through an explicit checkbox. Filters survive details, reloads, and browser navigation. An explicitly enabled **Unrestricted Weapon Skills** mod broadens the list while retaining the original requirements. Other mod visibility follows the current Game Setup.

### Configure mods and import custom classes

Choose **Enabled**, **Disabled**, or **Unknown** for each mod in **Data & settings > Game Setup**. The fixed Switch list is grouped by the two official packs. Known mod associations control definition searches and choices; unclassified entries stay visible. Character sheets retain their pinned Game Setup revision, including mod settings. See [playthrough mods](mods.md) for supported filtering and catalog gaps.

Vanilla class ratings, equipment permissions, and exported learn trees ship with the app, using a baseline assumed to match the game release at export. Class details include a growth calculator, and the modding guide provides searchable modifier references. Crystal Edit `mod.json` imports support custom classes and vanilla edits without replacing personal records. See [Crystal Edit data and growth estimates](crystal-edit.md).

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

While connected, open **Data & settings > Offline & storage**. If the app is not ready, choose **Prepare for offline use** and wait for **Offline ready** before relying on it without a connection. Offline preparation caches the application and its bundled reference data. Keep exporting backups for your personal records.

When an update is available, save open drafts and choose **Apply app update** in the same section. Updates wait for your approval.

Updates retain the active and previous offline builds, pruning older caches from the same installation. An update never forces other tabs to reload. Reload older tabs after saving their drafts to pick up the active build; IndexedDB records are separate from these caches.

Offline use requires the hosted app or a [local production build](development.md#preview-the-production-app). Development mode does not install an offline service worker.
