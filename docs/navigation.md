# Navigation and local links

Crystal Companion uses semantic hash routes so links work on static hosts, in a subdirectory, and with the prepared offline application. The path after `#` identifies a page, selected record, settings section, or modal action. Record links retain exact identities instead of using names as unique keys.

The main pages are Inventory, Characters, Builds, Progress, and Reference. Build library, team scenarios, comparison views, character tabs, and settings sections have separate routes. Inventory observations, character captures and learning records, build creation and editing, progress edits, reference overrides, and ruleset collection also have their own addresses.

For example, `#/inventory/new` opens the inventory form, `#/builds/teams` opens team scenarios, and `#/settings/ruleset` opens ruleset settings. A character's spell tab uses `#/characters/<character-id>/magic`. Snapshot inspection uses `#/characters/<character-id>/history/snapshots/<snapshot-id>`, and comparison uses `#/characters/<character-id>/history/compare/<snapshot-a-id>/<snapshot-b-id>`. Each ID must belong to the selected character; missing snapshots show recovery controls without substituting the current snapshot. A catalog definition uses `#/reference/catalog/<catalog-id>/revisions/<revision-id>/entities/<entity-id>`, preserving the source revision even when names are duplicated.

Definition pickers and their create/edit dialogs extend the parent route. Universal search has an address too. Back and Forward traverse these layers while keeping the parent form available. Cancel or the close button returns to the parent view; a directly opened dialog has a safe parent destination even without an earlier app history entry.

URLs describe navigation, not a backup of unsaved form fields. Refresh can reopen the same form or picker, but unsubmitted input is not a durable saved record. Save the form before relying on a bookmark to preserve its contents. Navigation guards keep protected build, ruleset, and definition drafts open until they are saved or explicitly discarded. Universal search keeps an underlying form open until it is finished or closed before navigating to a result.

Personal record links depend on the active playthrough and browser storage at the same origin. A copied link does not transfer the referenced data to another browser or device. Import a native backup and select the relevant playthrough before opening its record links. A missing record or unavailable catalog revision produces a recovery message instead of silently opening a different record.

Import previews depend on the file selected in that browser session. Their URLs cannot restore the file bytes after refresh; reopen the local file to review the preview again. Visiting any route does not approve an import or perform a saved-data mutation.

Reference and inventory filter parameters remain in the address where needed. Source filters display readable labels while retaining the exact source values for filtering and provenance. The older encoded search-target and reference-selection links are accepted and converted to semantic paths.

A slot action in the recorded character sheet opens the capture route with its definition-picker descendant. The picker focuses search on opening and returns focus to its field on closing. A changed snapshot form blocks outside dismissal, Escape, and navigation away until saved or explicitly cancelled, and warns before browser refresh. After a storage failure, closing the form leaves the application recovery draft available for Retry save or backup export.
