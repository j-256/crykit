# Correcting the reference

Open a catalog entry and choose **Correct shared reference** to update its name, description, aliases, and facts for every playthrough in this browser. **Create personal version** makes a separate version for the selected playthrough. Once a personal version exists, **Edit personal version** opens its preferred revision; **Save personal revision** preserves previous revisions and the exact references used by existing records. Both editors use the same overview, typed fact controls, source comparisons, and save footer. The entry's action labels and scope explanation identify which playthroughs the change affects before you open an editor.

Choose **Fact to edit** to inspect a value or compare differing source claims. Facts can contain text, numbers, booleans, lists, or structured JSON. Unknown and not-applicable states remain explicit. Use **Add fact** for missing information and **Restore source value** to undo a field edit. Supported numeric facts update the definition's planning values, including when a value becomes unknown or is removed. Personal and catalog detail pages share definition facts, planning fields, source trails, and imported claims. Personal history links open the exact source and previous revision.

**Evidence & game context** holds optional notes, a source locator or screenshot identifier, confidence, decision type, platform, game version, and mod applicability for a catalog correction. **Visibility** controls whether an entry appears in browsing and choices. For a small correction, choose **Quick edit**, click highlighted text, and choose **Save**. **Add evidence or detail** opens the quick editor's optional metadata. **Done editing** returns to reading. Pasted content is plain text and is never executed.

Save controls remain visible while the full editor scrolls. Validation and save failures keep the entered values open for retry. Attempting to leave an unsaved draft presents **Save and continue**, **Discard and continue**, and **Keep editing**. Browsing the fact selector or comparing sources does not create an unsaved edit. Corrections saved for other definitions can merge with an open draft. If another tab changes the same definition, the editor preserves the draft, shows the latest saved changes for comparison, and requires an explicit discard and reload before saving against that version.

A quick edit starts tentative. Confirming an observation records the contributor's judgment; it does not establish universal game-version or platform parity. For example, refining a broad shop group into a specific vendor and city can reconcile compatible source descriptions without proving that the same location applies on Nintendo Switch with every mod configuration. The original descriptions, source revisions, and applicability remain available through **View original** and **Why this changed**.

## Collect and submit a delta

Open **Corrections** from Reference or Data & settings. Review the changes, choose entries, and export the JSON file. It contains exact original and proposed values, original auxiliary claims, source revisions, decision IDs, explanations, evidence locators, applicability, and the superseded decisions needed to explain the selected edits. It excludes inventory, characters, builds, profile identifiers, source archives, and attachments. Review free-form text for personal details before sharing, and provide any permitted evidence attachments separately.

The exported file is a portable contribution and a standalone backup. Importing it shows a preview before writing. An import does not pick an array-order winner between competing proposals. The reference uses the original source while competing decisions await an explicit **Use this decision** choice. This creates another immutable decision that names what it supersedes. A changed original value, source revision, or catalog checksum requires a fresh comparison before the correction applies. Missing sources leave the proposal available for export.

Full profile backups also contain the global correction registry. Restoring a profile leaves that registry alone unless **Restore reference corrections from this backup** is selected. That option merges immutable decisions in the same transaction as the profile restore. Older backups without corrections remain supported. Corrections are shared browser knowledge and are not part of profile Undo; **Restore baseline** records an explicit reversal, with **Undo restore** available in the corrections dialog.

## Decisions and certainty

Decision types distinguish a factual correction, equivalent descriptions, compatible refinement, different scope, and a reviewed contradiction. Differing imported wording alone is presented as differing source values. Every decision retains its exact target, expected source values, source revisions, and baseline checksum. Corrections cannot replace a saved decision ID with different content, and supersession must be acyclic and stay within the same exact target.

Local corrections are a separate view over immutable catalogs. Reference details, search, facets, and ordinary definition choices use that view. Supported numeric facts also update their derived PP cost, occupied slots, and listed stat contributions in the corrected view; unknown or hidden facts cannot leave an old known planning value behind. Existing inventory, builds, personal overrides, and ruleset locks retain their exact saved references and validate against their original snapshots. Applying a proposed correction locally does not silently revise a saved build's rules.

Ordinary browsing and choices omit superseded catalog revisions and hidden entries. Build pickers use the revision pinned by their active ruleset and its original planning values; a local reference proposal cannot silently change the cost shown for a saved rule. Existing selections, direct links, and historical records still resolve the original identities. A reviewed baseline revision can then be used for new plans without rewriting old plans or observations.

## Review and promote into the shipped baseline

The objective is a reference that ships with verified, applicable knowledge. Local edits and incomplete provenance are useful drafts on the way there. Keep original unknowns explicit until evidence supports a reviewed decision.

Inspect a submission locally:

```sh
npm run corrections:review -- submitted-corrections.json
```

The JSON report includes the original and resulting values, provenance, decision, and remaining review issues. Review the actual evidence and applicability. The command cannot verify that a contributor's assertion is true. It rejects malformed data and detects stale or competing decisions; it does not upload anything.

After checking the evidence, prepare a new immutable revision:

```sh
npm run corrections:review -- submitted-corrections.json --promote --revision reviewed-release-name --output reviewed-catalogs.json
```

Promotion requires confirmed decisions with a rationale, evidence, and recorded platform, version, and mod context. Context can explicitly document an unverified applicability boundary; promotion preserves the catalog's overall applicability rather than upgrading unknown parity to known. Unresolved knowledge and competing or stale proposals must be reviewed first. The output path must be new, and the revision ID must not already exist.

The generated bundle contains the original snapshots, the new snapshot, its checksum, and explicit current-revision selection. Inspect the bundle, place it at `src/catalog/reviewed-catalogs.json`, and run `npm run verify`. Commit the reviewed authoring data with the implementation's normal source-review workflow. No personal export or private evidence attachment belongs in the repository. The app bundles the catalog locally and makes no runtime requests for it.

Promotion preserves catalog identity while changing revision identity and checksum. It retains prior snapshot values and reviewed decision history, recomputes supported derived planning facts, and leaves saved references and ruleset pins intact. Reference details explain reviewed changes and link to their source revisions. Further baseline edits must produce another revision instead of modifying one already shipped. The original wiki ingestion and confirmed Switch sources remain separate authoring inputs; changing them still requires their own source verification.
