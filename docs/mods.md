# Playthrough mods

Open **Data & settings > Ruleset** to record individual **Enabled mods** and **Disabled mods**, one name per line. Saving creates an immutable ruleset revision for the active playthrough. Case and extra whitespace do not change a mod's identity. A mod listed in both fields rejects the save; entered values remain available to correct. Names not recorded in either field stay unknown. Installing a mod pack does not establish which included mods are enabled in a save.

**Use confirmed Switch setup** fills the platform and individual mod choices for the configuration used to verify the bundled Warrior square map. Review the fields before saving. It does not establish the game version, PP rules, slots, or any character's learning. The application starts with a blank playthrough and does not apply this setup automatically.

## Definition visibility

Reference searches, universal definition search, character and build pickers, and screenshot class choices omit an entry when its confirmed source mod is explicitly disabled. The built-in associations cover Equipment Expansion items, Doge Shield, Bloodmage, Tempest, Forcemage, Barbarian, and the separately named Mod Pack 2 bosses. These associations use the bundled source identities from the Equipment Expansion sheet and Nintendo publisher descriptions, not name similarity. Personal overrides inherit their source association; unrelated same-name imports and personal definitions do not.

A known source mod with an unknown or conflicting setting stays visible with that state beside the entry. Entries whose source-mod association is not established also stay visible. This is partial applicability coverage: the catalog does not establish every mod's added abilities, equipment, trainers, or tree changes. Enabling a mod does not manufacture its missing definitions or verify the catalog's platform and game-version parity. Mods that change PP costs, equipment permissions, or other mechanics are recorded as configuration; their effects are not inferred from their names.

Recorded inventory, character learning, snapshots, and plans are retained when a mod is disabled. Exact definition links still open, and a picker retains its current exact selection with its mod state. A character sheet shows **Recorded mods** from the snapshot's pinned ruleset revision and labels its recorded selections against that configuration. Changing the active ruleset does not reinterpret the earlier sheet. Capture a new snapshot to record the new context.

## Backup and recovery

Native backups preserve enabled and disabled lists with each ruleset revision, including unknown and conflicting imported claims. Backups without a disabled list remain readable and keep those settings unknown. Older application builds that do not support the optional disabled list cannot restore backups containing it. Restoring contradictory definite enabled and disabled lists fails validation before changing the stored profile.

Mod settings and filtering work locally without game-data requests. Existing transaction rollback, retry, undo, and offline backup behavior applies to ruleset saves. A source association controls visibility only; it never deletes a personal record or marks an ability learned.
