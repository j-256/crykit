# Built-in catalog sources

Crystal Companion ships a static, revisioned reference catalog so a blank local profile can search and inspect Crystal Project definitions without importing a file or making a runtime network request. Catalog definitions remain separate from inventory, character learning, party progress, and other personal observations. Finding an entry never establishes that the player owns, learned, unlocked, or can use it.

## Community wiki snapshot

The broad reference layer is generated from the public [Crystal Project community wiki](https://crystal-project.fandom.com/wiki/Crystal_Project_Wiki) through its MediaWiki API. It includes class infoboxes and stat growth, class skill and passive tables, resource and learning costs, prerequisites, targeting and effect text, documented Vanilla-mode differences, equipment and item tables, item pages, monster templates, statuses, areas, commands, crafting recipes, and other substantive game-reference pages. Every extracted entity keeps its exact page revision, section or row locator, source applicability note, and page link.

The committed catalog contains normalized factual fields and plain text. It does not retain images, advertisements, scripts, interactive maps, or executable wiki markup. Structured lists, records, and tables render as data in the reference view. The application never fetches the wiki at runtime.

The wiki identifies its content terms as [CC-BY-SA](https://www.fandom.com/licensing). Wiki-derived content remains under those terms and retains page-level attribution; the application's AGPL-3.0-only license does not replace source-content rights. Refreshing the snapshot requires reviewing both the generated changes and the upstream licensing declaration.

Community documentation can be incomplete, stale, internally inconsistent, or based on a different game release. The catalog therefore does not claim complete Nintendo Switch coverage, parity with a particular official mod-pack snapshot, or verified calculation order. Source disagreements remain conflicting claims. Missing kind-specific fields remain explicit unknowns.

## Supporting identity sources

Stable base item, equipment, class, and Monster Magic identities also come from the public [Crystal Project Archipelago world](https://github.com/Emerassi/CrystalProjectAPWorld), principally its [item table](https://github.com/Emerassi/CrystalProjectAPWorld/blob/main/worlds/crystal_project/items.py), [class constants](https://github.com/Emerassi/CrystalProjectAPWorld/blob/main/worlds/crystal_project/constants/jobs.py), and [Scholar ability constants](https://github.com/Emerassi/CrystalProjectAPWorld/blob/main/worlds/crystal_project/constants/scholar_abilities.py). That project targets a Steam Archipelago branch and does not establish Nintendo Switch compatibility. Its repository is MIT-licensed, and this catalog uses its factual labels and source links.

Equipment Expansion labels come from the [public Equipment Expansion item sheet](https://docs.google.com/spreadsheets/d/1s3kWj2DONAln5hRx7p4JyEfr71wkLIM-KC3LTA3gNks/edit#gid=0). Nintendo's [Mod Pack 1 description](https://www.nintendo.com/us/store/products/mod-pack-1-quality-fun-70050000048696-switch/) supplies its named rule changes, and Nintendo's [Mod Pack 2 description](https://www.nintendo.com/en-gb/DLC/Mod-Pack-2-New-Challenges-2646897.html) supplies high-level entries for Passive Trainer, Doge Shield, Equipment Expansion, the custom classes, and additional bosses. These publisher descriptions establish that the features exist and preserve the details they state, but they do not provide complete stats, skills, locations, formulas, or bundled source revisions. They also do not establish that the public equipment sheet or a wiki revision captured by this process matches the packaged Switch revision.

## Explicit gaps

The built-in reference entry named `Wiki catalog coverage gaps` collects source names without matching wiki detail, links to wiki pages that do not exist, pages that were not represented as standalone definitions, parser issues, and the unresolved platform-parity warning. An unmatched preexisting name stays available with `Wiki coverage` marked unknown rather than receiving inferred mechanics. Each matched entity also lists expected fields that its sources did not document.

Redlinks are leads, not proof that the named concept is a distinct game entity. Pages without standalone definitions include redirects, collection pages, and source-only table or summary pages as well as material the extractor could not classify. Review the source before promoting any gap to a new definition.

## Refreshing the snapshot

Run `npm run catalog:update` to fetch main-namespace pages, expanded categories, latest available revisions, redirects, and the item-category tree. The command writes an ignored source cache, regenerates `src/catalog/wiki-data.json`, and updates the combined starter digest in `src/catalog/data.ts`. Use `npm run catalog:update -- --cache` only to reproduce generation from the existing local cache.

Review the generated entity and gap changes, preserve stable starter IDs where identity is unchanged, and bump the built-in catalog revision before publishing a changed snapshot. Run the complete local verification suite. GitHub Actions must remain disabled.

The snapshot checksum uses a `builtin:sha256:` namespace over the supporting source map, stable name records, and generated wiki content digest. It is catalog identity metadata, not an imported private-file digest.
