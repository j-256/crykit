# User guide

Start with the [first-build walkthrough](../README.md#try-your-first-build) if you are new to Crystal Kit. This guide covers the details you can explore as you need them.

[Getting around](#getting-around) · [Builds](#create-and-save-builds) · [Teams](#check-a-team) · [Characters](#record-characters) · [Inventory and progress](#track-inventory-and-progress) · [World Map](#explore-the-world-map) · [Reference](#browse-reference-data) · [Backups](#imports-backups-and-privacy) · [Offline use](#use-the-app-offline)

## Getting around

The app opens to the build library. Builds, Teams, Reference, World Map, and Mods share the main menu. Characters, Inventory, and Progress live under Tracking. Buildcrafting works without entering a Playthrough or characters. Tracking connects plans to your observed game state when you choose to use it.

The first visit includes a labeled sample Playthrough with sample characters, their starting equipment, character sheets, reusable Builds, and an active sample party plan. These synthetic records are for exploring the planner. Start a new Build, create a blank Playthrough for your own tracked game, or replace all planner data with an import. Builds, Teams, and Game Setups are shared across Playthroughs. Reloading retains saved edits; clearing the browser's application data starts the sample again.

### Choose a Playthrough and Game Setup

**Game Setups** describe the game rules used for planning: base game version, difficulty, and enabled mods. Open **Builds > Game Setups** or **Data & settings > Saved setups** to create or edit a reusable setup. **Start a Build** uses the chosen setup as a starting point. Each saved checkpoint keeps its exact rules, so later edits do not change earlier plans.

The editor puts **Game version** and **Difficulty** first. **Enter exact version** accepts a version not listed. **Base game details** contains platform and mode. New setups default to **Standard** mode; opening a saved setup retains its recorded mode. **Mods** contains ordered imported revisions, with named choices under **Mods without imported files** for cases where a mod file is unavailable. A mod name alone does not establish its calculation effects. **Rules from game data** shows supported changes and coverage gaps. PP budgets and equipment layouts are not arbitrary configuration controls.

Saving creates a new setup revision. Unchanged forms cannot create duplicate revisions. **Discard changes** restores the opened revision after confirmation. Closing with unsaved changes asks whether to discard or keep editing. A failed save retains the draft for **Retry save**.

A **Playthrough** represents one tracked game save and owns characters, inventory, progress, and party plans. Its selector appears on Tracking pages. Open **Data & settings > Playthrough** to switch saves, or expand **New Playthrough** to create a blank one. A new Playthrough starts in Standard mode with unknown platform, version, and mods unless you explicitly choose an existing setup. This page displays the selected rules as a read-only summary. Choose a saved revision under **Game Setup to apply**, review its summary, then choose **Apply to** followed by the Playthrough's name. Create or edit version, difficulty, and mods under **Saved setups**. Saving a setup never applies it to a Playthrough automatically.

**Party plan** selects the tracked party used for inventory and readiness checks. **None selected** clears the selection without deleting a plan. Finish open drafts or retry failed saves before switching.

## Manage mods

Open **Mods > Editor workspace**, choose a Crystal Edit JSON file, and inspect or edit its records. Apply edits to save the working draft, then choose **Save to CryKit** to add it to **Mod library**. Saved versions are grouped by project ID; changed contents create another revision. **Edit mod JSON** opens an exact saved source for further editing. Selecting a class, item, passive, or growth class whose mod is not enabled opens a confirmation dialog. Choose **Enable and select <definition>** to enable its exact source version and accept the selection. **Cancel**, Escape, or closing the dialog preserves the previous field value. **Version details** offers other bundled or saved versions. A bundled source is archived locally only after confirmation. **Game Setup** starts collapsed; expand **Game Setup > Mods** to manage sources, enabled state, and calculation support. An existing build with a disabled required mod offers **Enable <mod>** directly in its calculation message, opening the same dialog. **Save build** or **Save new revision** saves those rules and exact source pins with the checkpoint. Saved Game Setups supply starting templates; other builds and the Playthrough retain their own rules. **Add another mod** offers the rest of the library, and **Mod priority and replacement links** controls ordering and reviewed identity links.

Supported game and mod data supplies calculation constants and difficulty effects. The collapsed **Game Setup** summary names enabled source mods and distinguishes named-only settings. **Rules from game data** shows the selected bonus profile first; expand **All bonus profiles**, **Other rule changes**, or **Difficulty and engine rules** for more detail. Rule changes use plain-language effect labels, with the exact technical names available from info icons on hover, keyboard focus, or tap. Incomplete or unsupported changes remain explicit. The library is included in planner backups; editor drafts have separate downloads. See [Mods and the editor workspace](mod-inspector.md) for inspection, exports, and recovery.

## Create and save builds

Choose **Builds > New Build** to open a blank Build sheet. Type into class, sub-command, equipment, accessory, or passive fields and select a matching catalog or personal definition. Search text never becomes a saved selection or creates a definition. Sub-commands use **Command (Class)** labels. The sub-command supplies its command without granting that class's equipment permissions. No recorded inventory, character, or learned skills are required.

A new Build starts with the most recently edited personal Build's Game Setup, or the selected planning setup when no personal Build is available. Sample Builds are not used as the previous-Build default. The editor identifies the starting context above Game Setup. Creating a member within a Team reuses that Team's first assigned checkpoint setup. Open **Game Setup** to choose version, difficulty, and mods, or **Copy Game Setup** to use a saved setup. Changes save with the checkpoint and leave other builds and Playthroughs unchanged. Equipment uses the standard layout; passives form an ordered list. Named mod choices support Enabled, Disabled, and Unknown, while imported mods supply exact definitions and supported calculation constants.

Class, equipment, and passive controls appear before the collapsible **Stats & growth** section. Section shortcuts jump directly to each group. The primary class's stat ratings use the game's colored full and half stars. The same ratings appear in Reference, with source details and explicit unknown values. Class ratings describe base-stat scaling and growth; they are separate from a character's recorded stats. Build editing starts at level 60 with all growth in the primary class when no calculation inputs were saved. Adjust level and growth history under **Loadout > Stats & growth > Calculated stats**, and choose **Calculation gender** in the stats overview. Explicitly saved unknown levels remain unknown. If an input blocks totals, the page explains what needs attention and keeps available components visible; choose **Review Game Setup** for a setup blocker.

### Choose equipment and passives

Equipment searches exclude identified category articles. Search matches names, displayed stats, and effects, prioritizing exact names and identifying matches found in details. Press Enter to choose a sole result, or use the arrow keys to select among matches. Choices show catalog stats and effects, with full reference fields and attribution available beneath each selection. Native equipment records show their source identity and level to distinguish similarly named items. Native effects and numeric facts take precedence over reviewed older summaries. Readable descriptions, strategy, and directions remain visible under **Description**, with attribution and corrected historical claims in **Sources**. Similar spellings remain separate identities and are labeled when their relationship is unconfirmed; entries supported only by name evidence sort after detailed records.

Selected fields show definition artwork, and empty fields show their slot's role icon. Primary class summaries put the command name and icon first, followed by equipment permission icons; hover or focus an icon for its name. Sub-command summaries omit those permission icons. Monetary cost appears last in detailed facts and is omitted from compact field summaries. PP remains visible for passive planning. On wide screens the selection inspector stays beside the loadout, showing a prompt until a definition is inspected. Narrow layouts stack the inspector below the fields. The library starts collapsed above the editor on every screen size.

Equipment searches assess candidates against the whole draft, including equipment permissions and occupied hands. **Search filters** holds category, ordering, compatibility, and broader-source controls. **Hide known equipment conflicts** is on by default; hidden matches show their count and an action to reveal them. If every match is hidden, the picker explains the equipment requirements and recovery options. Unknown compatibility remains visible. Filter by **Equipment category** or order by a listed stat with **Sort results**; unknown stat values follow known values. These are definition values, not a ranking of final Build totals. A two-handed Mainhand explicitly occupies Offhand, with an action that clears Mainhand before choosing another Offhand. Slot-specific issues appear beside the selection and offer review links in Build validity.

Passive results show effects and PP costs, and both pointer hover and keyboard navigation update the inspector. A passive already selected in another row is excluded from new choices; clear its existing selection before moving it. The current row's selection remains visible, including in older builds with duplicates, which still show a validation conflict. **Within remaining PP** accounts for the passive being replaced; it excludes unknown costs while enabled and is unavailable when the remaining budget is unresolved. Search results default to the chosen Game Setup. **Broader planning options** exposes disabled or unconfirmed mods and other source variants. Existing selections stay visible. Expand **Mod passive options** above the passive fields to include learnable innates. The innate toggle starts from the setup's enabled mod state and remembers an explicit browser preference across Builds; it does not change saved passives or rules.

A Build without a class displays draft guidance rather than a successful compatibility badge. Empty equipment slots are allowed and do not imply a compatibility conflict. Build validity sums the PP costs of every equipped passive against the pinned Game Setup's limit and reports unresolved costs separately. The PC 1.6.9 model uses the game's 10 PP budget. Imported mods can change individual passive costs; unsupported rule changes remain unresolved. The limit is a budget, not a count of passive positions or a character observation. Validation also checks documented class, equipment, slot, hand, and passive rules without depending on a character or inventory. These loadout checks are separate from stat calculation coverage. Stat views identify their resting preview scope, with further details under **Calculation coverage** beside the totals.

### Save checkpoints and make copies

**Save build** in the page header creates the Build and its first checkpoint together. Enter the optional **Build title** at the top of a new sheet; an unnamed Build uses its class name. **Checks & notes** contains rotation notes, assumptions, and the checkpoint name. The sheet stays directly editable on desktop and mobile, and further passive rows appear as selections are added.

Choose **More > Rename** in a saved Build's header to change its title. Title and tags share one **Save details** action. This updates the Build's library metadata without creating a checkpoint or saving unfinished loadout edits. Closing More retains the draft. **Cancel details** discards both title and tag edits; leaving with either edited offers **Save and continue** or **Discard and continue**.

Tags are optional labels for organizing your Build library, such as `healer` or `early game`. Open **More > Tags** in a saved Build's header to add or remove them. Type one tag at a time and press Enter or choose **Add tag**; suggestions reuse tags from your library. **Save details** also includes a tag still typed in the input. Spaces at the ends are trimmed, blank tags are ignored, and duplicate tags are combined without regard to letter case. New Builds offer **Tags** beside their title, saving them with the first checkpoint.

Turn off **Show sample Builds** to hide sample-tagged examples without deleting them. Library cards display saved tags, and both library search and Cmd+K / Ctrl+K search match them. Clones retain tags and complete backups preserve them; share links omit these library labels.

Choose **More > Clone Build** to make a separate Build within the same Game Setup. **Save new revision** in the header creates a new immutable checkpoint. The header's **Editor checkpoint** selector chooses the content base; saving from an older checkpoint creates a new latest revision. Builds from another Game Setup remain directly editable using their checkpoint's pinned behavior and catalog definitions.

Builds have no lifecycle classifications. Use optional tags such as `template` or `theorycraft` to organize them; any saved Build can be cloned as a starting point. Save status and checkpoint history describe the actual saved configuration, while tracked party plans retain their separate draft and hypothetical contexts.

Repeated equipment defaults to **Use a separate item**. Under **Item copies**, choose **Share one item with** another slot only when the game allows one physical item to occupy both. This is a planned allocation and does not record inventory. Selecting a Build collapses the library to leave room for the editor; library search and revision comparison remain inside its disclosure.

Optional tracking actions live under **Use with Tracking**, including character comparisons, recording, and party readiness. Readiness and recording actions follow the saved checkpoint displayed in the editor. Creating a party plan from readiness uses the saved checkpoint's Game Setup and catalog snapshot, even when the current Playthrough uses another Game Setup. Shared validation causes are grouped, with affected slots and links to the relevant records or settings.

### Explore stat estimates

The build editor also checks documented equipment permissions, hand occupancy, roles, and unique flags before a scenario exists. On **Loadout**, **Calculated stats** saves the calculation level and growth allocation with each checkpoint, defaulting to level 60 and all growth in the primary class. Untouched allocations follow the primary class and level; editing one preserves your manual allocation until explicitly reset. Numeric controls and fixed-scale sliders share one allowance. Totals show male and female bonuses separately, and sample damage benchmarks illustrate stat differences. **Export calculation package** shares the versioned formulas, constants and evidence without personal data. Model-less saved plans also use supported native numeric inputs. Missing levels and unsupported custom assumptions remain unknown. **Checks & notes** offers native coefficient-power and physical-hit-curve previews with explicit stage limits. Calculations do not alter recorded character data. See [build mechanics and calculation scope](planner-mechanics.md).

Class pages and build plans offer scoped calculations with explicit inputs. Conditional battle effects, encounter simulation, optimization, and automatic game-state inspection require additional verified data.

## Share a build or team

Choose **Share build** on a build card or an open saved checkpoint, or **Share team** on a saved Team, then choose **Copy link**. Build cards share the latest checkpoint. A recipient sees **Read-only snapshot**, can inspect its selections, and can choose **Save a copy**. A new unsaved Build or Team shows **Not yet saved**. Matching Game Setups are reused; a different setup gets a unique name if its name is already taken. Team copies save four build slots directly, without requiring tracked characters. **Include written notes** adds rotation notes, written assumptions, and checkpoint names. Build behavior and calculation inputs are always included, and character observations and inventory remain local. See [share links](share-links.md) for URL capacity, catalog requirements, and privacy.

## Check a team

Open **Teams > New Team**, name the Team, and choose a saved checkpoint or **Create member** in each slot. The checkpoint picker searches names, classes, commands, equipment, setups, and notes; preview each exact revision and optionally hide sample Builds before selecting it. **Edit member** opens the selected checkpoint within the Team, including its editable **Build title**. Renaming changes the Build name wherever it is used. **Save member and return to Team** saves the Build title, checkpoint, assignment, and pending Team changes together. A failed save keeps the member draft available without saving a partial Team. Cancel discards the member rename and loadout edits and returns to the pending Team name and slot selections. The same Build can appear in several slots.

Team review separates filled slots, selected classes, equipment occupancy, known build issues, and unresolved checks. Optional empty equipment does not mark an otherwise filled Team as a draft. Empty or partial Teams can still be saved. Equipment names remain visible on Team cards, with keyboard-accessible inspection and **Edit this slot** to open that member at the relevant field. **Edit member** starts at the editor introduction, and returning restores the Team position. Saving another Build checkpoint leaves existing Team pins unchanged and displays a **Newer checkpoint available** notice. Expand **Compare checkpoints**, choose **Update this slot**, then **Save Team** to retain the change. Teams can be shared and copied independently of tracking.

To use a Team in a tracked game, open its **Use with Tracking > Adopt Team** action, or **Save and adopt Team** when Team edits are pending. Match the slots to four distinct characters in the selected Playthrough. Each slot offers a comparison of recorded equipment, classes, and passives with the proposed build. **Check party readiness and shared equipment** checks learning and simultaneous stock use. All checkpoints must use compatible Game Setups to record one party. Confirm **I applied these builds in game** before recording.

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

### Track class seals

Open **Progress > Class seals** to track each vanilla class from **Class not acquired** through **Class unlocked**, **Class mastered**, and **Seal acquired**. Click a tile to advance it; clicking an acquired seal resets it to not acquired. The class and seal links open their Reference entries without changing the mark. Use **Edit multiple** to select a group and set it to one state, or **Details** on a recorded tile to inspect its observations and notes.

Marks save automatically to the selected Playthrough and are included in backups. They record party-wide progress without marking any character's skills learned or changing inventory. Imported uncertainty remains available for review. If a save fails, finish recovery through the application's retry or backup controls before switching context.

### Track summons

Open **Progress > Summons** to mark Summoner skills available for the active Playthrough. The board follows the game's skill-tree layout, omits the passive nodes, and labels each summon with its deity title. Pinga is the starting summon and stays gold (unlocked); its tile cannot be toggled. The other tiles start gray; click a tile to turn it gold, then click again to undo. There is no intermediate blue stage and no record of which characters learned the skills. For the other summons, defeat the deity with a Summoner in your party before marking the skill available.

Follow **Skill** or **Deity** beneath a tile to open its matching Reference page without changing its unlock state. Marks save automatically, remain separate between Playthroughs, and are included in backups. Imported unknown or conflicting unlock values show **Needs confirmation** until you choose a state. If a save fails, the tile returns to its saved state and offers **Retry summon**. The board and bundled artwork work offline after preparing the app. See [summon reference evidence](summons.md) for the source scope.

### Track travel and capability unlocks

Open **Progress > Travel & unlocks** to mark mount instruments, reusable shrine stones, and capability items acquired or not acquired for the selected Playthrough. Each tile shows a game icon and links to its attributed location and requirements in Reference. Search and filter the checklist to review what remains. Imported values that are unknown or conflicting stay unconfirmed until you choose a state. These marks save automatically and remain separate from inventory quantities and character learning.

### Follow the Golden Quintar guide

Open **Progress > Quintar breeding** for an ordered guide through nursery access, wild eggs, both breeding branches, and the Golden Quintar. Unmarked tiles have gray symbols; clicking a tile marks it complete and restores its color. Click again to undo. Instructions stay visible, and **Go to next step** takes you to the first unmarked tile. **Class seals** returns to the mastery board.

Each breeding tile shows its parents, minimum first-place wins on different race tracks, and which parents to keep or release after hatching. Repeated wins on one track count once. Desert and Highland require one win from their partner, River two, Black three, Aqua four, and Gold five. Release advice follows the displayed route only; retain quintars you need for another purpose. **Breeding tips** explains readiness, food effects, nursery space, and Incubator use from Windows PC 1.6.9 game facts. The Ocarina price comes from the bundled native shop data. The chosen route and capture landmarks retain their guide attribution. Switch and mod applicability remain unverified.

Completion marks belong to the selected Playthrough, save automatically, and survive reloads and native backups. You can mark steps in any order; missing prerequisite marks remain visible and are never filled in automatically. Marks record completed actions without changing your inventory, nursery roster, character learning, or class seals. A failed save restores the tile's saved state and offers **Retry step**. The guide works offline after preparing the application for offline use.

## Explore the world map

Open **World Map** to explore the bundled Windows PC 1.6.9 map. Drag to pan, use the zoom controls or the mouse wheel to zoom, and choose **Fit map** to see the selected layer. Nearby markers group together at wider views; zooming reveals individual locations. Use **Map layer** to switch between the overworld and underground maps where places overlap.

Use **Search map** to find a place, NPC, boss, resource, chest, or chest contents. Selecting a result reveals its marker and opens its details, even when it belongs to another map layer. Marker details retain source coordinates, contents, conditions, and available Reference links. Filters let you choose the kinds of locations and sources to show. **Resources** covers source-backed mining nodes, planting plots, and ground pickups; **Objects** keeps voxel props such as buttons and movable blocks separate from people. Mod markers have a separate outline and source label so their provenance remains visible without relying on color alone.

Select a **Game Setup** to preview its ordered mod layers. You can also preview mods separately from your saved setups, including Equipment Expansion and arbitrary bundled or imported Crystal Edit projects. Preview choices affect this map view; they do not enable a mod in your game or rewrite saved builds. Import a project through **Mods > Editor workspace** and save it to CryKit to make its source available alongside bundled projects.

The atlas depicts the inspected base game's terrain. Crystal Edit exports can supply added or overridden entity placements and definitions, but they do not supply replacement voxel world geometry. A mod that changes terrain may therefore have placements whose backdrop differs from the game. Unresolved entities, missing coordinates, and unsupported changes remain explicit. Map markers describe possible placements and interactions; they do not establish whether a chest is opened, an NPC is present, a boss is defeated, or an item belongs to your Playthrough. The map reveals locations and rewards and can contain spoilers. See [map sources and boundaries](catalog-sources.md#native-world-map).

## Browse reference data

Verified native game facts appear as ordinary content without citation markers. Uncertain values and external claims, including wiki guidance and mod or imported records, use a small superscript quotation-mark **Sources** icon attached to the relevant text. Click or tap it for attribution and evidence in a compact popup. Escape closes the popup and returns focus to the icon; readable descriptions and gameplay requirements stay with the content. Original source records remain preserved even when their citations are not shown.

A searchable, revisioned reference combines native Windows game records, mod exports, and attributed community evidence for items, classes, abilities, passives, innates, Monster Magic, monsters, commands, statuses, recipes, and locations. Catalog presence never establishes ownership or learning. Documented facts, source conflicts, and missing details remain distinct, and Nintendo Switch or official mod-pack parity is not assumed; see [catalog sources](catalog-sources.md). Sample equipment follows the bundled class pages' initial equipment lists, while unverified rules and displayed stats remain unresolved. Additional reference files and personal records can be imported locally.

### Search and filter

Reference groups categories into equipment families, classes and skills, combat effects, world and enemy details, and mods. Search reaches every category, including imported categories and detailed source tags. Definition types are grouped by purpose; choosing a type narrows the category suggestions.

Equipment categories combine base-game and mod definitions under the same type. Choose **Axes**, for example, to see both base and mod axes, then use **Source mod** to narrow the results to **Base game** or a particular mod. Reviewed native equipment types use readable labels, such as **Light armor** for Dress, without repeating an equivalent older wiki Type field.

Separate class, equipment-slot, element, source-mod, source, and PP filters use recorded fields and documented associations where available. Alternatives within a filter are combined; different filters narrow results together.

Active selections remain visible above the results and can be removed individually or cleared together, including when mobile filters are closed. Filters survive details, browser navigation, and reloads. Unknown and conflicting values remain possible matches where appropriate; missing facts are not inferred from names or descriptions.

Opening a definition uses the full content width. Short facts share columns, while tables and longer descriptions have their labels above them and span the page. On narrow screens, wide tables scroll within their own area. **Back to results** returns to the retained search and filters. Catalog and personal definitions use the same layout.

### Find item acquisition routes

Open an item or equipment entry and look under **How to obtain** for supported shops, chests, monster drops, steals, recipes, rewards and trades, starting inventory, and Lost & Found recovery. Follow a monster, recipe, ingredient, or required-item link to inspect its exact reference. **Game mode** selects Standard, Vanilla, or Chaos and stays in acquisition links and the address through reloads.

Routes retain their costs, quantities, conditions, and source limits. Steal availability and per-attempt success are separate values. **No acquisition route found** means the indexed sources did not resolve a route; it does not mean the item is unobtainable. Base-world routes do not establish Switch, modded, or randomized placement. See [acquisition sources and boundaries](catalog-sources.md#finding-acquisition-routes-from-an-item).

### Inspect enemy modes and difficulty

Native monster pages offer separate **Game mode** and **Difficulty** controls. Mode chooses the source record or its native override; difficulty previews supported changes to HP, MP, attributes, and combat inputs. These choices stay in the address and leave saved Game Setups unchanged. Stat modifiers and battle effects can change final values. Action weights are source values, not action probabilities, and missing source facts stay unresolved.

### Find weapon skills

To browse weapon skills, choose **Reference > Weapon skills > Weapon skills usable with > Dagger**, or press Cmd+K / Ctrl+K, type **dagger**, and open **Skills usable with Dagger**. On mobile, open **Filters** first. Results include multi-weapon and any-weapon skills, with class, listed weapon requirements, and cost visible. Spells and ordinary abilities are excluded. Unknown or conflicting requirements are available through an explicit checkbox. Filters survive details, reloads, and browser navigation. An explicitly enabled **Unrestricted Weapon Skills** mod broadens the list while retaining the original requirements. Other mod visibility follows the current Game Setup.

### Configure mods and import custom classes

Choose **Enabled**, **Disabled**, or **Unknown** for each named mod in the Game Setup editor. Open **Data & settings > Saved setups > Edit setup** for reusable planning rules, then **Playthrough > Game Setup to apply** to use the saved revision for a tracked game. The fixed Switch list is grouped by the two official packs. Known mod associations control definition searches and choices; unclassified entries stay visible. Character sheets retain their pinned Game Setup revision, including mod settings. See [playthrough mods](mods.md) for supported filtering and catalog gaps.

Brawler and its class skills are associated with **Moonlight Project**. Their mod badges and availability follow that entry's recorded setting. The Monk's base-game Brawler passive is a separate definition.

Vanilla class ratings, equipment permissions, and learn trees ship with the app, extracted directly from the game's database. Class details include a growth calculator, and the modding guide provides searchable modifier references. Crystal Edit `mod.json` imports support custom classes and vanilla edits without replacing personal records. See [Class data, Crystal Edit imports, and growth estimates](crystal-edit.md).

### Report reference data and create custom definitions

Use **Report a data issue** to open the project issue tracker. Include the entry, platform, game version, enabled mods, expected value, and supporting evidence. Native records establish facts for their recorded source version; community claims and unresolved platform differences keep their evidence. Catalog fixes go through source review and the extraction or interpretation pipeline.

Definition fields open compact searchable dropdowns beside the selected field. Choices include descriptions, source labels, and relevant stock or PP details. The surrounding form stays usable, and dropdowns fit the available space above or below their field. Search receives focus on opening; arrow keys browse choices, Enter selects, and Escape returns to the field.

Creation and editing use centered dialogs with a dim, unblurred backdrop. An outside click closes the dropdown first; unsaved-draft checks still apply to editing dialogs.

Catalog entries are read-only. Create a standalone **personal definition** from a picker or global search when an entry is missing from your reference data. These custom records are shared across your Playthroughs. **Edit custom definition** saves a new immutable revision; recorded ownership, learning, and Builds retain their exact references. Previously saved catalog versions remain readable and selectable, but cannot be cloned or edited. Reference can collect saved personal definitions into a new Game Setup revision without changing the Playthrough's current Game Setup or existing selections. Use imported Crystal Edit files and Game Setup mod layers for source-backed game modifications.

## Search, drafts, and bookmarks

Press Cmd+K on macOS or Ctrl+K elsewhere, or use the visible search button, to search definitions, inventory, characters, builds, teams, and progress. Arrow keys move through results, Enter opens one, and Escape closes the search. Open forms must be finished before navigating to another record.

Build drafts can remain open while browsing Reference or World Map in the same tab; use **Return to build draft** or the Builds navigation button to resume selections, title, and notes. Save before reloading or closing the tab. Other navigation, context changes, and failed saves retain their draft guards.

Pages, record details, settings sections, and modal workflows have semantic URLs. Copy the address bar to bookmark the selected view or reopen a dialog. Browser Back and Forward follow the same navigation, including nested definition pickers and editors. See [navigation and local links](navigation.md) for refresh, draft, and missing-data behavior.

Ordinary page and record links open a view without transferring your saved records. **Share build** and **Share team** instead encode a snapshot for another browser to preview and save; see [share links](share-links.md). Use a backup to move your complete planner data.

## Imports, backups, and privacy

Save open forms, then choose **Data & settings > Import & backup > Export backup**. The backup includes all Playthroughs, Game Setups, Builds, saved records, and retained history. Keep a copy outside your browser.

To restore on another browser or device, open **Data & settings > Import & backup** and select the backup under **Import or restore**. Review the preview before confirming. A native restore replaces all local planner data in that browser; it does not merge two sets of records.

Use Data & settings to preview a local reference workbook, supported research JSON/package, or native backup before importing it. Reference definitions do not establish ownership, learning, or mastery. A historical acquisition is preserved separately from current stock. Unsupported or conflicting mechanics remain unresolved.

The application makes no automatic requests for game data and has no login, telemetry, remote fonts, or cloud synchronization. Personal files stay in browser storage unless explicitly exported. Native backups can contain private notes and source records; handle them as personal files. A native restore replaces the local planner-data root after confirmation, while separate save lineages belong in Playthroughs inside that root.

See [local data and interchange](data-formats.md) for supported inputs, backup structure, planner-data replacement behavior, and recovery boundaries.

## Use the app offline

While connected, open **Data & settings > Offline & storage**. If the app is not ready, choose **Prepare for offline use** and wait for **Offline ready** before relying on it without a connection. Offline preparation caches the application and its bundled reference data. The first download can take time on a slow connection; preparation stays in progress until installation completes. If installation fails, reconnect and retry. Keep exporting backups for your personal records.

When an update is available, save open drafts and choose **Apply app update** in the same section. Updates wait for your approval.

If an update or artwork change does not appear, save your changes and choose **Refresh app** under **Data & settings > Offline & storage** while connected. This downloads the latest app files and reloads the current tab, keeping saved Playthroughs, Builds, imported references, browser preferences, and Mod Inspector originals and drafts. It also repairs cached files when the app version has not changed. If a download fails, the tab stays open and the existing cached files remain available; reconnect and retry. Clearing all site data in developer tools also deletes your saved records, so use **Refresh app** for app updates.

Updates retain the active and previous offline builds, pruning older caches from the same installation. An update never forces other tabs to reload. Reload older tabs after saving their drafts to pick up the active build; IndexedDB records are separate from these caches.

Offline use requires the hosted app or a [local production build](development.md#preview-the-production-app). Development mode does not install an offline service worker.
