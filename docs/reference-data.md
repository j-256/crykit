# Reference data boundaries

Reference, search, definition pickers, and calculations resolve catalog snapshots by exact identity and revision. Native records establish facts only for their recorded game version and platform. Supplemental sources still provide acquisition locations, guidance, and other facts absent from the extracted files. Unknown values and material source conflicts remain visible with their evidence.

## Source fixes

Use **Report a data issue** on a Reference entry to open the project issue tracker. Include the entry, platform, game version, enabled mods, expected value, and source evidence. A fix belongs in extraction, source interpretation, or an explicitly versioned catalog update so every consumer uses the same definition.

The retired corrections framework projected local edits onto catalog identities without changing their revision or checksum. Browsing and planning could then use different facts for the same record. Its context labels did not enforce platform, version, or mod scope. Reference has no local correction registry, correction import or export, or catalog-promotion command.

Catalog cloning is also retired. A generic personal copy retained native source fields while allowing normalized facts to change. Consumers that interpret native records could disagree with consumers reading those edited facts. Such a copy could not reliably represent modified game behavior. Use Crystal Edit source files and explicit Game Setup mod layers for that purpose.

## Standalone custom definitions

A personal definition created from a picker or global search is a standalone entry in the shared local library. It can represent a missing item or other definition without claiming a catalog identity. Editing saves a new immutable revision; it does not rewrite saved Build selections, inventory observations, or learning records. Unsupported mechanics remain unknown. Custom facts alone do not establish native calculation support.

Previously saved catalog-derived personal records remain readable and selectable. Their exact fields, lineage, source references, Game Setup pins, and Build references remain supported in imports, backups, and shares. They are read-only in Reference, pickers, and direct editor routes. Standalone custom records remain editable. The domain mutation enforces this boundary as well as the UI.
