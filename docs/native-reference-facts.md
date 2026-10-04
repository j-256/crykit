# Native reference projections

The interface prefers facts from the fingerprinted Windows PC 1.6.9 databases and reviewed game code. Original community and editor records remain in the immutable catalog for attribution, historical comparison, direct links, and saved Builds. Their presence does not make them the authority for a fact that the game already supplies. No projection changes catalog checksums, imports, backups, personal definitions, or recorded progress.

## Replacements

| Reference content | Native source and behavior |
| --- | --- |
| Equipment, passive, ability, status, and item descriptions | The bounded description renderer expands the game's vocabulary and supported display rules, including linked item abilities. It reports unsupported parts and retains distinct original guide notes even when native display fields are complete, unless a separate receipt proves the complete original claim is replaced. It never executes imported text or formulas. |
| Listed equipment stats | Exact native flat modifiers replace reviewed older scalar values in Reference. Original values and differences remain in the Sources popup. Build summaries use the same native records. |
| Shoudu Stew's effect | Its item record links to an ability that recovers missing HP. The conflicting historical effect claims remain inspectable beside the native evidence. |
| Acquisition notes | Field-specific receipts compare the entire original claim with supported native routes. Matching notes move to the Sources popup; mixed directions and additional advice remain visible. Rewards include reviewed penguin, arena, and Salmon Run conditions. |
| Gardening | Native seed, encounter, growth, and watering rules supply seed guidance, including integer rounding and the seed whose watering reduction is zero. |
| Duplicate definitions | Reviewed field and relationship evidence links alternative equipment, item, map, monster, status, passive, and recipe entries to native definitions. Class commands link to their class without changing kinds. Default discovery prefers verified counterparts while selected originals and direct links remain valid. |
| Modifier and formula research | Reviewed native semantics lead corrected reference entries. Original guide wording remains evidence, and calculation references retain their actual supported scope. |
| Quintar breeding | Native rules supply pairing outcomes, distinct-track race requirements, readiness, food, nursery, and hatch facts. Route order, capture directions, and keep/release advice retain their author attribution. |
| Class portraits and menu icons | Exact native texture bindings replace verified equivalent wiki images while preserving visible pixels and scale. Unmatched artwork retains its original provenance. |

[Relationship receipts](../src/catalog/native-reference-links.json) bind each reviewed link to the catalog revision, checksum, native fingerprints, original fields, and related records. Runtime guards refuse changed records and other catalog revisions. `npm run native-reference-links:check` reproduces the relationships and checks every residual record's disposition. A matching name alone neither merges an identity nor suppresses a result.

[Acquisition receipts](../src/catalog/acquisition-guidance-receipts.json) require the reviewed field value and complete native routes. A native route does not prove that all prose on the item page is redundant. Ember Scythe's historical drop claim differs from the native steal table and remains explicitly identified as a source disagreement. A missing route is never a claim that an item is unobtainable.

The [certainty report](catalog-certainty.json) distinguishes stored source knowledge from presentation coverage. Stored conflicts remain historical evidence even when native facts resolve the displayed value. A complete generated description means the supported native display fields were rendered; it does not prove a community strategy note unnecessary or reproduce a full battle simulation.

## Retained content

Directions, chosen routes, strategy, and optimization advice can add information beyond game coordinates and rules. Switch observations and mod-specific claims need evidence for their own platform or version. Rights, attribution, publishing history, and external-tool documentation cannot be established by game databases. Original records also remain necessary to resolve saved references without silently changing their meaning.

The relationship manifest distinguishes verified native links from mechanics, geography, mod-source, article, and identity review. Those review dispositions are explicit outstanding evidence boundaries, not claims that the native source lacks the information. Ambiguous variants and incomplete claim matches stay separate until their identity or complete meaning is established. Source inspection must precede promotion; similarity is insufficient.

## Remaining uses of "supplemental"

| Location | Reason retained |
| --- | --- |
| `supplemental-entity-ids.json` and catalog identity helpers | Permanent allocations support stable references for records without a native model identity. The filename and allocation keys are compatibility machinery, not a certainty label. |
| Immutable catalog `legacy` metadata and original source snapshots | These record assembly history and preserve exact checksums. Native and mod facts are classified by their actual sources in the interface. |
| Research importer arrays and tests | Additional input arrays are part of a supported import shape; their unknown fields and original claims must survive round-trips. |
| Mod Inspector reference baselines | Animation, voxel, and editor-folder records extend the main schema snapshot. They are fingerprinted native/editor facts, described that way in user documentation. |
| Test fixtures | Synthetic examples exercise older metadata, conflicting claims, and reference compatibility. They do not label current gameplay data. |

Ordinary Reference and search views use concrete source names and version labels. Original claims, source disagreements, and unsupported behavior remain available without treating all historical community content as a separate class of gameplay data.
