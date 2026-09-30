# Built-in catalog sources

Crystal Companion ships a static, revisioned reference catalog so a blank Playthrough can search and inspect Crystal Project definitions without importing a file or making a runtime network request. Catalog definitions remain separate from inventory, character learning, party progress, and other personal observations. Finding an entry never establishes that the player owns, learned, unlocked, or can use it.

## Community wiki snapshot

The broad reference layer is generated from the public [Crystal Project community wiki](https://crystal-project.fandom.com/wiki/Crystal_Project_Wiki) through its MediaWiki API. It includes class infoboxes and stat growth, class skill and passive tables, resource and learning costs, prerequisites, targeting and effect text, documented Vanilla-mode differences, equipment and item tables, item pages, monster templates, statuses, areas, commands, crafting recipes, and other substantive game-reference pages. Every extracted entity keeps its exact page revision, section or row locator, source applicability note, and page link.

The committed catalog contains normalized factual fields and plain text. Artwork is bundled separately as described below. The catalog does not retain advertisements, scripts, interactive maps, or executable wiki markup. Structured lists, records, and tables render as data in the reference view. The application never fetches the wiki at runtime.

The wiki identifies its content terms as [CC-BY-SA](https://www.fandom.com/licensing). Wiki-derived content remains under those terms and retains page-level attribution; the application's AGPL-3.0-only license does not replace source-content rights. Refreshing the snapshot requires reviewing both the generated changes and the upstream licensing declaration.

Currency amounts display as gold, silver, and copper coin icons, with the amount before each icon. The maintainer confirms the in-game conversion of 100 copper per silver and 100 silver per gold. Whole and mixed prices use descending nonzero denominations; zero remains zero copper. This applies to explicit currency amounts in costs, tables, descriptions, and read-only previews. Original source values remain intact in stored definitions, editing fields, and exports. Unknown or unsupported amounts stay as text, and metal item quantities such as Gold Ore are not treated as money. Coin images have accessible denomination labels and text fallbacks, and their [screenshot-derived artwork provenance](../src/assets/coins/README.md) is separate from the wiki snapshot.

Community documentation can be incomplete, stale, internally inconsistent, or based on a different game release. The catalog therefore does not claim complete Nintendo Switch coverage, parity with a particular official mod-pack snapshot, or verified calculation order. Source disagreements remain conflicting claims. Missing kind-specific fields remain explicit unknowns.

Reference details show every competing field value with its source, locator, revision, applicability, and any claim note. Different values can reflect wording or scope differences; the importer does not decide whether they describe the same fact. Choose **Review source differences** or **Create personal version** to review normalized field claims for the selected playthrough. **Keep unresolved** preserves all evidence by default. Selecting a claim and saving creates a preferred personal revision with that exact value and source attribution. Original catalog claims, saved inventory observations, and build references retain their earlier definitions. The catalog detail links to an existing preferred personal version without removing its source conflicts.

### Native game artwork snapshot

Base items, equipment, and classes prefer artwork extracted from a maintainer-owned Windows installation. This is a build-time snapshot only: the application never reads an installation, scans the machine, or requests game data at runtime. The extraction manifest records a content fingerprint over every inspected database pack, texture pack, and the game executable without retaining the machine-local input path.

The extractor strictly reads the game's byte-inverted JSON databases and named PNG texture packs. The binary layouts are independently documented by the pinned [CrystalProjector database schema](https://github.com/iconmaster5326/CrystalProjector/blob/79320b343d603aa069aa023fd54020d36419e082/schema/ksy/database.ksy) and [texture-pack schema](https://github.com/iconmaster5326/CrystalProjector/blob/79320b343d603aa069aa023fd54020d36419e082/schema/ksy/texture_pack.ksy). Indexed icons use the exact 32x32 cell rule verified against the fingerprinted Windows executable. Class artwork combines both explicitly recorded actor-sheet variants using the executable's class-icon crop. The generator does not identify sprites from filenames, visual resemblance, or display-name similarity.

`src/catalog/game-identities.json` is the explicit bridge from bundled catalog IDs to native database IDs. It is generated from a full pinned commit of the public Crystal Project Archipelago item table and its constants, whose numeric codes document the native database ID plus a category-specific offset. The generator accepts only an exact supported source namespace and one upstream record. Display-label differences between that source and the installed database are preserved in coverage metadata; the numeric crosswalk, not punctuation or spelling, establishes the record identity. Catalog entries from other sources remain explicit identity gaps.

`src/catalog/game-assets.json` inventories every named embedded texture, every inspected data file, all database references to those textures, input hashes, extraction regions, catalog bindings, and unresolved artwork cases. `src/catalog/game-artwork.json` is the smaller runtime projection. Content-addressed PNGs in `src/assets/game-assets/` contain only the exact crops needed by catalog bindings. An ability record with no direct texture path stays unresolved rather than inheriting a guessed generic icon. Source-label discrepancies and records without direct artwork stay reviewable in manifest coverage.

The Travel & unlocks checklist includes item identities absent from the public crosswalk. `src/catalog/game-travel-identities.json` records reviewed item database IDs and the exact `item.dat` checksum inspected for them. The asset updater checks each record's ID and label against that database before extracting its icon; a changed database requires review of these bindings. Reference details show the native record, source texture crop, and database fingerprint for the extracted artwork. Personal definition overrides do not inherit the bundled item's icon.

Refresh the identity crosswalk and native artwork independently:

```sh
npm run game-identities:update -- --ref <full-archipelago-commit>
npm run game-identities:check
npm run game-assets:update -- --input <game-content-directory>
npm run game-assets:check
```

Add `--unpack <new-output-directory>` to `game-assets:update` to write every named embedded PNG plus an inventory outside the repository for local inspection. The target must not exist and the command refuses repository-local unpacking. The default committed snapshot keeps the complete hashed inventory but bundles only catalog-bound crops. Review all crosswalk, input-fingerprint, coverage, and asset changes before committing. Offline checks validate the committed crosswalk, runtime projection, exact PNG bytes, content bounds, and one-to-one asset-directory membership.

Native game artwork remains copyrighted Crystal Project material and receives no AGPL or CC-BY-SA grant through this project. Provenance and checksums support auditing, not a claim of ownership or redistribution rights. The snapshot establishes only the inspected Windows installation's appearance. It does not establish Nintendo Switch or optional mod-pack parity.

### Wiki sprite and icon fallback

The Progress class mastery board uses the pinned wiki full-body world sprites instead of native class-icon crops. These sprites retain their exact class bindings, content bounds, and local offline assets. Other catalog artwork continues to prefer exact native bindings.

When no exact native catalog binding exists, Reference results and details use local artwork where the wiki establishes an explicit association. Class images come from the class infobox at the catalog's recorded page revision. Equipment and status icons come from literal cases in the wiki's link templates. Monster images use pages with `MonsterBox2` and its verified `File:PAGENAME.png` rule. The manifest records both page and template revisions. Same-name skills, personal definitions, foreign catalogs, and unsupported mappings do not inherit guessed artwork. Missing mappings and missing wiki files remain recorded in manifest coverage; detail pages without either source say **No exact artwork linked**.

`src/catalog/wiki-sprites.json` records each file's source URL, upload timestamp, file-description revision, dimensions, MIME type, original SHA-1, local SHA-256, license label, and catalog bindings. The PNG, GIF, and WebP files in `src/assets/wiki-sprites/` retain the downloaded bytes. Entity artwork requires a byte-for-byte checksum match with the wiki upload. For older menu-icon PNGs that the CDN recompresses even with `format=original`, the downloader requires the original format and dimensions, records `representation: cdn-png`, and retains the upload SHA-1 and size separately from the downloaded-file SHA-1, SHA-256, and size. Offline checks verify the exact committed bytes. Individual images and the total snapshot have bounded sizes. Download, format, and checksum failures stop the refresh before the manifest is replaced. Cached verified downloads can be reused on a subsequent refresh.

Menu icons use a separate `icons` map in the sprite manifest, keyed by equipment category, skill type, element, or command. Weapon glyphs come from named wiki icon files; armor glyphs use bounded regions of the public Warrior and Monk equipment-menu images, preserving the complete source bytes. The icon template and command images in pinned class infoboxes or matching section headings supply the other associations. Equipment, type, category, command, and element fields can display these symbols beside their original labels. An ability named Fire does not acquire a fire-element icon from its name, and unknown or conflicting fields retain their recorded state. Unsupported categories remain text-only.

Character details, Reference fields, inventory, definition pickers, build previews, and learned-skill lists share compact artwork. Exact native artwork takes precedence, followed by exact wiki artwork; both remain restricted to their catalog identity. Generic skill icons describe a recorded type or category. Failed images leave the text readable. **Artwork source** shows the native database, texture crops, input fingerprints, and pinned crosswalk or the wiki file revision and mapping evidence. **Menu icon sources** in character and Reference details links to the pinned public file descriptions and their rights labels.

Artwork has separate rights from wiki text. For example, the [Warrior sprite file](https://crystal-project.fandom.com/wiki/File:Warrior-world-sprites.webp) and [Short Sword icon file](https://crystal-project.fandom.com/wiki/File:Short-sword-icon.gif) use the wiki's `Fairuse` declaration. That is the wiki's label for copyrighted artwork, not a CC-BY-SA or AGPL grant. Files without a reviewed declaration remain explicitly unspecified. Follow **Artwork source** on a reference detail to inspect the pinned file page, declared rights, and mapping evidence. Bundling does not establish redistribution permission or Nintendo Switch/mod-pack appearance parity.

Refresh artwork independently from the factual catalog:

```sh
npm run sprites:update
npm run sprites:update -- --cache
npm run sprites:check
```

The first command fetches the required source revisions, template mappings, file metadata, and images. `--cache` performs an offline replay from `.wiki-cache/sprites/` and requires its input catalog digest to match. `sprites:check` validates the manifest and local image bytes without network requests or writes; it also runs as part of `npm run check`. Review generated bindings, gaps, source/rights changes, and asset additions or removals before committing. Superseded asset files are left for explicit review and removal, and the privacy check rejects sprite files absent from the manifest.

Vite emits both native and wiki images with the static application assets, so offline preparation caches them together with the shell. No game installation, wiki, or CDN URL is used as an image source at runtime. Artwork metadata remains separate from immutable catalog facts and personal backups; refreshing artwork does not alter catalog checksums or recorded playthrough data.

## Crystal Edit class facts and modding guide

The bundled class export supplies vanilla numeric ratings, equipment categories, ability and passive membership, and learn-tree coordinates in a separate immutable catalog revision. Its game-release match is a maintainer assumption tied to the export date; the editor version is recorded independently. GEEF's modding guide supplies attributed modifier descriptions and the equations used by the class growth calculator. Saved references to earlier revisions remain valid. See [Crystal Edit data and growth estimates](crystal-edit.md) for provenance, custom class imports, and scope.

## Supporting identity sources

Stable base item, equipment, class, and Monster Magic identities also come from the public [Crystal Project Archipelago world](https://github.com/Emerassi/CrystalProjectAPWorld), principally its [item table](https://github.com/Emerassi/CrystalProjectAPWorld/blob/main/worlds/crystal_project/items.py), [class constants](https://github.com/Emerassi/CrystalProjectAPWorld/blob/main/worlds/crystal_project/constants/jobs.py), and [Scholar ability constants](https://github.com/Emerassi/CrystalProjectAPWorld/blob/main/worlds/crystal_project/constants/scholar_abilities.py). That project targets a Steam Archipelago branch and does not establish Nintendo Switch compatibility. Its repository is MIT-licensed, and this catalog uses its factual labels and source links.

Equipment Expansion labels come from the [public Equipment Expansion item sheet](https://docs.google.com/spreadsheets/d/1s3kWj2DONAln5hRx7p4JyEfr71wkLIM-KC3LTA3gNks/edit#gid=0). Nintendo's [Mod Pack 1 description](https://www.nintendo.com/us/store/products/mod-pack-1-quality-fun-70050000048696-switch/) supplies its named rule changes, and Nintendo's [Mod Pack 2 description](https://www.nintendo.com/en-gb/DLC/Mod-Pack-2-New-Challenges-2646897.html) supplies high-level entries for Passive Trainer, Doge Shield, Equipment Expansion, the custom classes, and additional bosses. These publisher descriptions establish that the features exist and preserve the details they state, but they do not provide complete stats, skills, locations, formulas, or bundled source revisions. They also do not establish that the public equipment sheet or a wiki revision captured by this process matches the packaged Switch revision.

## Explicit gaps

The **Travel & unlocks** roster uses explicit item identities for mount instruments, reusable shrine stones, and selected capability items. The bundled travel supplement promotes Ibek Bell, Owl Drum, and Salmon Cello from the pinned Mounts sections, and New World Stone and Old World Stone from the [Tools table revision](https://crystal-project.fandom.com/wiki/Tools?oldid=7601). Their definitions retain section or row attribution and unverified platform/mod applicability. The Old World Stone table lists Particular Ore without a full route; the reference preserves that limited evidence. A new immutable bundled revision includes these definitions, while the preceding revision remains available to pinned records. Acquiring an instrument does not establish a particular bred Quintar, current inventory quantity, character skill, or build permission.

The built-in reference entry named `Wiki catalog coverage gaps` collects source names without matching wiki detail, links to wiki pages that do not exist, pages that were not represented as standalone definitions, parser issues, and the unresolved platform-parity warning. An unmatched preexisting name stays available with `Wiki coverage` marked unknown rather than receiving inferred mechanics. Each matched entity also lists expected fields that its sources did not document.

Redlinks are leads, not proof that the named concept is a distinct game entity. Pages without standalone definitions include redirects, collection pages, and source-only table or summary pages as well as material the extractor could not classify. Review the source before promoting any gap to a new definition.

## Refreshing the snapshot

Run `npm run catalog:update` to fetch main-namespace pages, expanded categories, latest available revisions, redirects, and the item-category tree. The command writes an ignored source cache, regenerates `src/catalog/wiki-data.json`, and updates the combined starter digest in `src/catalog/data.ts`. Use `npm run catalog:update -- --cache` only to reproduce generation from the existing local cache.

Review the generated entity and gap changes, preserve stable starter IDs where identity is unchanged, and bump the built-in catalog revision before publishing a changed snapshot. Run the complete local verification suite. Keep GitHub Actions disabled for private repositories; see [deployment](deployment.md) for the public repository workflow.

The snapshot checksum uses a `builtin:sha256:` namespace over the supporting source map, stable name records, generated wiki content digest, and confirmed Switch supplement. The enriched Crystal Edit revision additionally hashes the complete canonical catalog content, including its normalized class and guide facts. These are catalog identities, not imported private-file digests.

## Confirmed Switch skill names

The bundled Switch supplement records in-game class and skill identities separately from community wiki identity matching. Barbarian, Tempest, Brawler, and Freelancer entries retain confirmed names and node kinds, while mechanics, costs, and weapon requirements remain unknown. A same-name skill from another class does not supply those missing details. The supplement participates in the catalog content checksum and carries explicit in-game provenance without personal screenshots or character records.

Barbarian and Tempest entries follow their corresponding mod settings. Brawler and Freelancer have unconfirmed mod ownership, so their visibility is not assigned to a guessed toggle. Preparation is a Tempest passive distinct from the Squall innate. Neither Squall nor Barbarian's Toughness is learned from the confirmed trees. Shapeshifter represents appearance-passive unlocks and is not included as a combat class.
