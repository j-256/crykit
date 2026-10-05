# Crystal Project save editor

Open **Save editor** from CryKit's main menu to edit a Crystal Project `.sav` file locally. Choose a file, review its party and inventory, make changes, and download an edited copy. The original file stays available as a separate download. Save editing does not import records into a Playthrough or change planner data.

## Supported saves

The editor supports every serialization format recognized by the inspected native reader: formats 0 through 28, including the inverted version bytes used by early saves. It reads each format's header layout and keeps that format on export, allowing the game to run its own historical migrations when loading the edited file. Older formats without a saved timestamp show that value as unavailable. An unchanged export preserves the original bytes.

Editing uses the bundled Windows PC 1.6.9 definitions and rules for unmodded Standard-mode saves across these formats. Serialization support is separate from game-rule compatibility: the format number does not identify the game version or prove matching definitions on another platform. Newer formats beyond the inspected reader's range remain read-only until their layout is verified.

Files with incompatible modes, mod mappings, unknown native IDs, or unsupported record structures cannot be edited. The editor explains the restriction and retains the original download when it can open the file. Malformed or oversized files are rejected. Choosing an invalid replacement file leaves an existing draft available.

## Make changes

- Edit money in copper, character names, classes, subclasses, and levels. Level changes keep growth and experience records consistent. Raising a level above the save's cap enables the level-cap assist, unless its challenge settings prohibit this. Changing class or subclass returns equipped gear to inventory so incompatible gear is not left equipped. A new main class also becomes the growth class for future levels; a matching subclass is cleared. Class changes reconcile equipped passives and automatic commands with the resulting classes.
- Search items and equipment by name or ID and set stock quantities. Item capacities include pouch bonuses; equipment capacity includes copies equipped by the party.
- Review broad changes before applying class mastery, inventory grants, map reveal, or the overpowered preset. Mastery updates each character's learning. Revealing maps fills existing map records; it does not create missing maps or complete quests.
- The overpowered preset grants level 99 with the game's level-cap assist, class mastery and JP, money, and supported inventory. It preserves current equipment and passive selections. Challenge settings that prohibit its level changes prevent the preset from applying.

The change preview compares the working copy with the opened file. Untouched fields, quest and event records, playtime, unknown BSON values, and combat-log bytes are retained. Deliberate inventory and learning changes also update their relevant acquisition records. The editor validates the output before starting the download.

## Export and install

1. Review the changes and choose **Export edited save**. Check that your browser has downloaded the file.
2. Close Crystal Project before replacing a game save. Keep a separate copy of the original.
3. Put the edited file in the game's save directory, using the filename of the intended save slot, such as `save1.sav`.
4. Open the game and load that slot. Keep the original until you have checked the edited party and inventory in-game.

The save directory is separate from the installed application. For native macOS, use `~/Library/Application Support/Crystal Project/Save/`. Windows uses the user's `Saved Games/Crystal Project/Save/` directory; Linux uses `~/.local/share/Crystal Project/Save/`. Compatibility wrappers can use their own virtual user folders. The [developer's FAQ](https://steamcommunity.com/app/1637730/discussions/0/2962796621651898428/) documents the native locations.

## Privacy and recovery

Save files are processed in browser memory and are never uploaded. Opened files and edits are not stored in IndexedDB or included in planner backups. Export before reloading, closing the tab, or switching tools. Draft guards warn about pending input and changes that have not been exported; a download starting is not proof that the browser saved it to disk.

**Download original** returns the exact opened bytes. Resetting changes restores that original. An unchanged codec round-trip preserves bytes exactly, including BSON numeric types, dates, field order, and untouched sections. Imported text is displayed as text, never executed.

Prepare CryKit for offline use under **Data & settings > Offline & storage** before disconnecting. The save editor and its bundled rules work offline with the rest of the app.

## Implementation and verification

The bounded binary and BSON codec lives in `src/interchange/crystal-save.ts`. Semantic validation and immutable editing operations live in `src/domain/save-editor.ts`; the native catalog adapter supplies version-scoped IDs and rules. The UI keeps original bytes separate from the working copy and from unapplied form input. No persisted planner format changes are needed.

Synthetic tests cover malformed framing, type preservation, unknown fields, consistent header and party edits, growth and inventory limits, and rejected operations without mutation. Browser tests exercise file input, review, export, draft protection, and offline use. Private game files and reference extracts must remain outside the repository; use made-up records for public bug reports and fixtures.
