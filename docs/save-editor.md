# Crystal Project Save Editor

Open **Save Editor** from CryKit's main menu to edit a Crystal Project `.sav` file locally. Choose a file, review its party and inventory, make changes, and download an edited copy. The original file stays available as a separate download. Save editing does not import records into a Playthrough or change planner data.

## Supported saves

The editor supports every serialization format recognized by the inspected native reader: formats 0 through 28, including the inverted version bytes used by early saves. It reads each format's header layout and keeps that format on export, allowing the game to run its own historical migrations when loading the edited file. Older formats without a saved timestamp show that value as unavailable. An unchanged export preserves the original bytes.

Editing uses the bundled PC 1.6.9.0 definitions and rules from the [verified Windows/macOS gameplay baseline](platform-coverage.md) for Standard, Vanilla, and Chaos saves across these formats, including saves with randomizer options enabled. Vanilla and Chaos apply their inspected native database patches before active mod layers. Randomizer mappings are validated against that effective catalog and applied to class abilities, passives, and innate loadout permissions. The editor preserves the saved seed, options, and mappings rather than rerolling them. An unmodded save can be edited immediately. For an actively modded save, CryKit automatically loads every bundled Crystal Edit revision whose project ID, declared version, and optional Steam Workshop identity match the save. Add JSON manually only for enabled revisions CryKit does not bundle. Definitions are applied in the save's recorded mod order, including its original-to-new ID redirects. Supported definitions are classes, abilities, passives, items, equipment, and genders; a source with other model families remains read-only.

Matching uses the project ID, declared version, optional Steam Workshop identity, and the saved redirect structure. The game does not store the source file's digest in the save, so CryKit cannot cryptographically prove that two different JSON files declaring the same identity and version are byte-for-byte equal. Use the same mod revision that created the save. Imported descriptions and formulas are retained as data and never executed.

Serialization support is separate from game-rule compatibility: the format number does not identify the game version or establish matching definitions outside the reviewed PC baseline. Newer formats beyond the inspected reader's range remain read-only until their layout is verified.

Files with malformed or conflicting randomizer state, unknown or conflicting mode values, missing or conflicting mod definitions, unsupported mod redirects, unknown IDs, or unsupported record structures cannot be edited. Randomizer support edits the save around its existing configuration; it does not change options, generate a seed, or reroll mappings. Disabled mods can leave their modded flag, redirect tables, and indexed records in the save; those saves remain read-only until reviewed through **Remove mod state**. A disabled mod's retained redirect table identifies its project but does not retain the enabled version, so CryKit can identify a bundled project without claiming that it recovered the exact saved revision. The editor also detects non-native indexed residue even when the mod flag and lists are already clear. It explains the restriction and retains the original download when it can open the file. Malformed or oversized files are rejected. Choosing an invalid replacement file leaves an existing draft available.

## Match mod definitions

Open the save and review the checklist under **Save mods**. A checked active mod has an exact bundled or imported definition match. A checked disabled mod has a known project, with **Saved revision unavailable** shown because the game removed that version from the save when the mod was disabled. CryKit checks bundled projects automatically. Choose **Add missing mod JSON** only for unchecked entries or to supply another source explicitly. A wrong project or revision remains listed as available in the tab but does not check the detected mod.

Bundled and manually loaded definitions stay in memory for the current tab's save-editor session; manually selected files are not added to the Mod library, planner backups, or browser storage. Bundled definitions can be loaded again automatically after reopening the tab. Manually supplied exceptions must be selected again.

CryKit validates the header and party copies of the active list and redirects before editing. In-place changes to existing native IDs do not need a redirect: the imported definition temporarily replaces that native definition while the save is open. Added records use the save's redirects, including identity redirects where the original and runtime ID are equal.

## Remove mod state

When supported mod state is present, **Review mod-state removal** builds a separate proposed draft. The review removes mod-only learned entries, JP records, equipped passives and equipment, inventory stock, atlas entries, indexed growth slots, and supported randomizer identity tails. It then clears the modded flag, active list, and redirects in both serialized copies without changing the save's Standard, Vanilla, or Chaos game mode. The result must validate solely against the bundled native definitions for that mode and survive normal save encoding before it can be exported.

Conversion deliberately refuses to guess when a party member currently uses a mod-only class, subclass, growth class, or gender, when mod-only growth history is nonzero, when randomized identities are active, or when populated redirect families are outside the supported set. A randomized save can be edited while its exact mod and randomizer layers remain active, but removing a mod can invalidate mappings produced against that modded database. Change those states in the game first, disable the mod from the title screen, save, and try again.

Clearing the mod metadata also restores native definitions for IDs a mod changed in place the next time the game loads the save. Conversion cannot infer or undo historical consequences such as previously earned currency, rewards, experience, event outcomes, or other changes no longer attributable to a particular mod. Review those values separately and keep the original save.

## Make changes

- Edit money in copper, then use **Party & loadouts** to focus one member at a time. The class, sub-command, equipment, and passive fields reuse the Build editor's searchable pickers. They contain native definitions plus definitions from exact active mod matches for this save, then narrow those choices to the member's unlocked classes, learned passives, and equipment available for that loadout. A mod from another saved Build or the general reference catalog is not offered merely because CryKit knows about it.
- Change a character's name or level independently. Level changes keep growth and experience records consistent. Raising a level above the save's cap enables the level-cap assist when permitted. A maximum-level challenge keeps its configured limit, and disabled assist options prevent enabling the level-cap assist. The level hint and rejected-edit message reflect these restrictions. Rejected edits bring their error notice into view and keep the input available to correct. A new main class also becomes the growth class for future levels; a matching subclass is cleared.
- Choose **Load a compatible Build** to propose the latest revision of a saved Build for the focused member. Compatibility requires every class, equipment, and passive reference to resolve through this save's native or active-mod definitions, the six equipment slots to map exactly, the member to have the required unlocks and learned passives, the passive total to fit the save's PP limit, and enough carried equipment to exist after returning the member's current gear. Build notes, calculations, growth plans, statuses, and inventory observations are not written to the save.
- Review a changed loadout before applying it. The loadout operation changes class, sub-command, six equipment slots, and equipped passives atomically; it returns old gear, consumes the requested carried copies, checks slot and class permissions, and recalculates available PP. A rejected loadout leaves the save draft unchanged.
- Search items and equipment by name or ID and set stock quantities. Item capacities include pouch bonuses; equipment capacity includes copies equipped by the party.
- Review broad changes before applying class mastery, inventory grants, map reveal, or the overpowered preset. Mastery updates each character's learning. Revealing maps fills existing map records; it does not create missing maps or complete quests.
- The overpowered preset grants level 99 with the game's level-cap assist, class mastery and JP, money, and supported inventory. It preserves current equipment and passive selections. Challenge settings that prohibit its level changes prevent the preset from applying.

**Working copy** shows applied changes before the long editing sections, and **Export edited save** stays in the page header. The change preview compares the applied working copy with the opened file. Untouched fields, quest and event records, playtime, unknown BSON values, and combat-log bytes are retained. Deliberate inventory and learning changes also update their relevant acquisition records. The editor validates the output before starting the download.

## Export and install

1. Review the changes and choose **Export edited save**. Check that your browser has downloaded the file.
2. Close Crystal Project before replacing a game save. Keep a separate copy of the original.
3. Put the edited file in the game's save directory, using the filename of the intended save slot, such as `save1.sav`.
4. Open the game and load that slot. Keep the original until you have checked the edited party and inventory in-game.

The save directory is separate from the installed application. For native macOS, use `~/Library/Application Support/Crystal Project/Save/`. Windows uses the user's `Saved Games/Crystal Project/Save/` directory; Linux uses `~/.local/share/Crystal Project/Save/`. Compatibility wrappers can use their own virtual user folders. The [developer's FAQ](https://steamcommunity.com/app/1637730/discussions/0/2962796621651898428/) documents the native locations.

## Privacy and recovery

Save files are processed in browser memory and are never uploaded. Opened files and edits are not stored in IndexedDB or included in planner backups. Export before reloading, closing the tab, or switching tools. Draft guards warn about pending input and changes that have not been exported; a download starting is not proof that the browser saved it to disk.

**Download original** returns the exact opened bytes. Resetting changes restores that original. An unchanged codec round-trip preserves bytes exactly, including BSON numeric types, dates, field order, and untouched sections. Imported text is displayed as text, never executed.

Prepare CryKit for offline use under **Data & settings > Offline & storage** before disconnecting. The Save Editor and its bundled rules work offline with the rest of the app. Mod-aware editing also requires the matching JSON files to remain available on the device for manual selection.

## Implementation and verification

The bounded binary and BSON codec lives in `src/interchange/crystal-save.ts`. Semantic validation and immutable editing operations live in `src/domain/save-editor.ts`; `src/domain/save-editor-mods.ts` projects inert Crystal Edit records, applies saved redirects, constructs the effective ordered catalog, and binds picker references to effective save IDs. Randomizer validation follows the game's patch, mod, then randomizer order. Stored party and inventory IDs are already effective IDs; mappings are applied when interpreting native class relationships. The native catalog adapter supplies version-scoped IDs and rules. The UI keeps original bytes separate from the working copy, automatically loaded bundled definitions, manually selected session-only definitions, and unapplied form input. No persisted planner format changes are needed.

Synthetic tests cover malformed framing, type preservation, unknown fields, consistent header and party edits, exact mod identity matching, mod and randomizer redirects, guarded mod-state removal, growth and inventory limits, and rejected operations without mutation. Browser tests exercise save and mod file input, review, export, draft protection, and offline use. Private game files and reference extracts must remain outside the repository; use made-up records for public bug reports and fixtures.
