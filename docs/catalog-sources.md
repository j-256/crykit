# Built-in catalog sources

Crystal Companion ships a static, revisioned reference catalog so a blank local profile can search and inspect Crystal Project definitions without importing a file or making a runtime network request. Catalog definitions remain separate from inventory, character learning, party progress, and other personal observations. Finding an entry never establishes that the player owns, learned, unlocked, or can use it.

## Community wiki snapshot

The broad reference layer is generated from the public [Crystal Project community wiki](https://crystal-project.fandom.com/wiki/Crystal_Project_Wiki) through its MediaWiki API. It includes class infoboxes and stat growth, class skill and passive tables, resource and learning costs, prerequisites, targeting and effect text, documented Vanilla-mode differences, equipment and item tables, item pages, monster templates, statuses, areas, commands, crafting recipes, and other substantive game-reference pages. Every extracted entity keeps its exact page revision, section or row locator, source applicability note, and page link.

The committed catalog contains normalized factual fields and plain text. Artwork is bundled separately as described below. The catalog does not retain advertisements, scripts, interactive maps, or executable wiki markup. Structured lists, records, and tables render as data in the reference view. The application never fetches the wiki at runtime.

The wiki identifies its content terms as [CC-BY-SA](https://www.fandom.com/licensing). Wiki-derived content remains under those terms and retains page-level attribution; the application's AGPL-3.0-only license does not replace source-content rights. Refreshing the snapshot requires reviewing both the generated changes and the upstream licensing declaration.

Community documentation can be incomplete, stale, internally inconsistent, or based on a different game release. The catalog therefore does not claim complete Nintendo Switch coverage, parity with a particular official mod-pack snapshot, or verified calculation order. Source disagreements remain conflicting claims. Missing kind-specific fields remain explicit unknowns.

Reference details show every competing field value with its source, locator, revision, applicability, and any claim note. Different values can reflect wording or scope differences; the importer does not decide whether they describe the same fact. Choose **Review conflicting fields** or **Edit as personal override** to review normalized field claims. **Keep unresolved** preserves all evidence by default. Selecting a claim and saving creates a preferred personal revision with that exact value and source attribution. Original catalog claims, saved inventory observations, and build references retain their earlier definitions. The catalog detail links to an existing preferred personal override without removing its source conflicts.

### Sprite and icon snapshot

Reference results and details use local artwork where the wiki establishes an explicit association. Class images come from the class infobox at the catalog's recorded page revision. Equipment and status icons come from literal cases in the wiki's link templates. Monster images use pages with `MonsterBox2` and its verified `File:PAGENAME.png` rule. The manifest records both page and template revisions. Same-name skills, personal definitions, foreign catalogs, and unsupported mappings do not inherit guessed artwork. Missing mappings and missing wiki files remain recorded in manifest coverage; detail pages without a match say **No wiki artwork linked**.

`src/catalog/wiki-sprites.json` records each file's source URL, upload timestamp, file-description revision, dimensions, MIME type, original SHA-1, local SHA-256, license label, and catalog bindings. The PNG, GIF, and WebP files in `src/assets/wiki-sprites/` retain the downloaded bytes. Entity artwork requires a byte-for-byte checksum match with the wiki upload. For older menu-icon PNGs that the CDN recompresses even with `format=original`, the downloader requires the original format and dimensions, records `representation: cdn-png`, and retains the upload SHA-1 and size separately from the downloaded-file SHA-1, SHA-256, and size. Offline checks verify the exact committed bytes. Individual images and the total snapshot have bounded sizes. Download, format, and checksum failures stop the refresh before the manifest is replaced. Cached verified downloads can be reused on a subsequent refresh.

Menu icons use a separate `icons` map in the sprite manifest, keyed by equipment category, skill type, element, or command. Weapon glyphs come from named wiki icon files; armor glyphs use bounded regions of the public Warrior and Monk equipment-menu images, preserving the complete source bytes. The icon template and command images in pinned class infoboxes or matching section headings supply the other associations. Equipment, type, category, command, and element fields can display these symbols beside their original labels. An ability named Fire does not acquire a fire-element icon from its name, and unknown or conflicting fields retain their recorded state. Unsupported categories remain text-only.

Character details, Reference fields, inventory, definition pickers, build previews, and learned-skill lists share compact artwork. Exact entity artwork remains restricted to its catalog identity; generic skill icons describe a recorded type or category. Failed images leave the text readable. **Menu icon sources** in character and Reference details links to the pinned public file descriptions and their rights labels.

Artwork has separate rights from wiki text. For example, the [Warrior sprite file](https://crystal-project.fandom.com/wiki/File:Warrior-world-sprites.webp) and [Short Sword icon file](https://crystal-project.fandom.com/wiki/File:Short-sword-icon.gif) use the wiki's `Fairuse` declaration. That is the wiki's label for copyrighted artwork, not a CC-BY-SA or AGPL grant. Files without a reviewed declaration remain explicitly unspecified. Follow **Artwork source** on a reference detail to inspect the pinned file page, declared rights, and mapping evidence. Bundling does not establish redistribution permission or Nintendo Switch/mod-pack appearance parity.

Refresh artwork independently from the factual catalog:

```sh
npm run sprites:update
npm run sprites:update -- --cache
npm run sprites:check
```

The first command fetches the required source revisions, template mappings, file metadata, and images. `--cache` performs an offline replay from `.wiki-cache/sprites/` and requires its input catalog digest to match. `sprites:check` validates the manifest and local image bytes without network requests or writes; it also runs as part of `npm run check`. Review generated bindings, gaps, source/rights changes, and asset additions or removals before committing. Superseded asset files are left for explicit review and removal, and the privacy check rejects sprite files absent from the manifest.

Vite emits the images with the static application assets, so offline preparation caches them together with the shell. No wiki or CDN URL is used as an image source at runtime. Sprite metadata remains separate from immutable catalog facts and personal backups; refreshing artwork does not alter catalog checksums or recorded playthrough data.

## Crystal Edit class facts and modding guide

The bundled class export supplies vanilla numeric ratings, equipment categories, ability and passive membership, and learn-tree coordinates in a separate immutable catalog revision. Its game-release match is a maintainer assumption tied to the export date; the editor version is recorded independently. GEEF's modding guide supplies attributed modifier descriptions and the equations used by the class growth calculator. Saved references to earlier revisions remain valid. See [Crystal Edit data and growth estimates](crystal-edit.md) for provenance, custom class imports, and scope.

## Supporting identity sources

Stable base item, equipment, class, and Monster Magic identities also come from the public [Crystal Project Archipelago world](https://github.com/Emerassi/CrystalProjectAPWorld), principally its [item table](https://github.com/Emerassi/CrystalProjectAPWorld/blob/main/worlds/crystal_project/items.py), [class constants](https://github.com/Emerassi/CrystalProjectAPWorld/blob/main/worlds/crystal_project/constants/jobs.py), and [Scholar ability constants](https://github.com/Emerassi/CrystalProjectAPWorld/blob/main/worlds/crystal_project/constants/scholar_abilities.py). That project targets a Steam Archipelago branch and does not establish Nintendo Switch compatibility. Its repository is MIT-licensed, and this catalog uses its factual labels and source links.

Equipment Expansion labels come from the [public Equipment Expansion item sheet](https://docs.google.com/spreadsheets/d/1s3kWj2DONAln5hRx7p4JyEfr71wkLIM-KC3LTA3gNks/edit#gid=0). Nintendo's [Mod Pack 1 description](https://www.nintendo.com/us/store/products/mod-pack-1-quality-fun-70050000048696-switch/) supplies its named rule changes, and Nintendo's [Mod Pack 2 description](https://www.nintendo.com/en-gb/DLC/Mod-Pack-2-New-Challenges-2646897.html) supplies high-level entries for Passive Trainer, Doge Shield, Equipment Expansion, the custom classes, and additional bosses. These publisher descriptions establish that the features exist and preserve the details they state, but they do not provide complete stats, skills, locations, formulas, or bundled source revisions. They also do not establish that the public equipment sheet or a wiki revision captured by this process matches the packaged Switch revision.

## Explicit gaps

The built-in reference entry named `Wiki catalog coverage gaps` collects source names without matching wiki detail, links to wiki pages that do not exist, pages that were not represented as standalone definitions, parser issues, and the unresolved platform-parity warning. An unmatched preexisting name stays available with `Wiki coverage` marked unknown rather than receiving inferred mechanics. Each matched entity also lists expected fields that its sources did not document.

Redlinks are leads, not proof that the named concept is a distinct game entity. Pages without standalone definitions include redirects, collection pages, and source-only table or summary pages as well as material the extractor could not classify. Review the source before promoting any gap to a new definition.

## Refreshing the snapshot

Run `npm run catalog:update` to fetch main-namespace pages, expanded categories, latest available revisions, redirects, and the item-category tree. The command writes an ignored source cache, regenerates `src/catalog/wiki-data.json`, and updates the combined starter digest in `src/catalog/data.ts`. Use `npm run catalog:update -- --cache` only to reproduce generation from the existing local cache.

Review the generated entity and gap changes, preserve stable starter IDs where identity is unchanged, and bump the built-in catalog revision before publishing a changed snapshot. Run the complete local verification suite. GitHub Actions must remain disabled.

The snapshot checksum uses a `builtin:sha256:` namespace over the supporting source map, stable name records, generated wiki content digest, and confirmed Switch supplement. The enriched Crystal Edit revision additionally hashes the complete canonical catalog content, including its normalized class and guide facts. These are catalog identities, not imported private-file digests.

## Confirmed Switch skill names

The bundled Switch supplement records in-game class and skill identities separately from community wiki identity matching. Barbarian, Tempest, Brawler, and Freelancer entries retain confirmed names and node kinds, while mechanics, costs, and weapon requirements remain unknown. A same-name skill from another class does not supply those missing details. The supplement participates in the catalog content checksum and carries explicit in-game provenance without personal screenshots or character records.

Barbarian and Tempest entries follow their corresponding mod settings. Brawler and Freelancer have unconfirmed mod ownership, so their visibility is not assigned to a guessed toggle. Preparation is a Tempest passive distinct from the Squall innate. Neither Squall nor Barbarian's Toughness is learned from the confirmed trees. Shapeshifter represents appearance-passive unlocks and is not included as a combat class.
