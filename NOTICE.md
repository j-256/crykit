# Credits and third-party notices

Crystal Kit is an unofficial fan planner for Crystal Project. It is independent of the game's creators and is not endorsed by them. The original application code is licensed under [AGPL-3.0-only](LICENSE). That license does not grant rights to third-party artwork, reference content, or trademarks.

## Game artwork

[Crystal Project](https://store.steampowered.com/app/1637730/Crystal_Project/) is by Andrew Willman. The game and its artwork belong to their respective creators and rights holders. Crystal Kit did not create the game's sprites, crystal artwork, or wiki images. Native Windows game artwork retains database IDs, texture regions, input fingerprints, and rights metadata in [the extraction manifest](src/catalog/game-assets.json); its smaller [runtime manifest](src/catalog/game-artwork.json) drives catalog and Quintar guide bindings. Bundled wiki fallbacks retain their source and rights metadata in [the wiki sprite manifest](src/catalog/wiki-sprites.json). Equipment Expansion cells retain their project-export or base-game archive provenance in [the mod sprite manifest](src/catalog/mod-sprites.json). Reference details expose the applicable native, mod, or wiki provenance, and [catalog sources](docs/catalog-sources.md#native-game-artwork-snapshot) explain these pipelines. The class mastery board also uses a direct crop of the in-game class seal icon from a maintainer-provided screenshot. The source screenshot and its personal gameplay records are not bundled.

The Quintar breeding guide uses native game quintar, egg, and item icons from the same extraction manifest. Its bindings record item and monster database references or the Golden Quintar actor-sheet crop and retain the game's separate artwork rights.

The wiki labels some files Fairuse and leaves others unspecified. Those labels are retained as source declarations; attribution does not turn the artwork into AGPL or CC-BY-SA material or establish a separate permission grant. For an attribution correction or rights concern, contact the maintainer through the [repository issues](https://github.com/j-256/crykit/issues).

The [currency icons](src/assets/coins/README.md) are isolated coin artwork from maintainer-supplied game screenshot crops, with transparency added around the original pixels. They retain the game's artwork rights and are separate from the wiki sprite manifest.

## Reference content

The native gameplay snapshot is extracted from Crystal Project Windows 1.6.9. Database and executable hashes, verified version evidence, and numeric identities are retained in [the gameplay snapshot](src/catalog/native-game-data.json). Game data retains source-specific rights; the application license and wiki license do not grant rights to it.

Mod Inspector's [editor schema snapshot](src/mod-inspector/reference-schema.json) records Crystal Edit enum names, model field types, and selector facts with executable fingerprints. It also includes minimal IDs and names from matching animation, voxel, and editor-folder references, each with its own source fingerprint and scope. These game and editor reference facts retain their source attribution. The snapshot does not include the editor executable or decompiled implementation.

Moonlight Project - Classes 2.2 is by Xenon. Its versioned Crystal Edit definitions and project metadata are retained in [the bundled mod snapshot](src/catalog/moonlight-project-v2.2.json). These definitions retain their source-specific rights; inclusion does not assert a separate license grant or apply the application's AGPL license to mod content.

Thanks to the [Crystal Project Wiki contributors](https://crystal-project.fandom.com/wiki/Crystal_Project_Wiki). Wiki-derived text retains its [CC-BY-SA terms](https://www.fandom.com/licensing), page links, and source revisions. The extracted catalog reorganizes and normalizes source material for search and comparison; it preserves conflicting and unknown claims. The application license does not replace these content terms.

[Catalog sources](docs/catalog-sources.md) also credits the Crystal Project Archipelago identity tables, public Equipment Expansion sheet, publisher mod-pack descriptions, Crystal Edit class exports, and modding guide. These references have their own provenance and applicability boundaries.

## Typography and software

Pixel Operator by Jayvee Enaguas (HarvettFox96) is bundled under [CC0 1.0](public/pixel-operator-CC0.txt). Its [font notice](src/assets/fonts/README.md) documents the source and WOFF2 conversion.

Runtime dependencies retain their upstream licenses:

| Software | License | Source |
| --- | --- | --- |
| React and React DOM | MIT | [React](https://github.com/facebook/react) |
| Dexie | Apache-2.0 | [Dexie.js](https://github.com/dexie/Dexie.js) |
| Zod | MIT | [Zod](https://github.com/colinhacks/zod) |
| fflate | MIT | [fflate](https://github.com/101arrowz/fflate) |
| Lucide | ISC, with MIT portions from Feather | [Lucide](https://github.com/lucide-icons/lucide) |
| Tesseract.js and its OCR engine | Apache-2.0 | [Tesseract.js](https://github.com/naptha/tesseract.js), [Tesseract](https://github.com/tesseract-ocr/tesseract) |
| English language data package | MIT package declaration | [Language data](https://github.com/naptha/tessdata) |

The lockfile identifies the exact installed packages. The build collects their packaged license and notice files into `third-party-licenses.txt`, available from Credits & licenses and included in offline preparation. These files remain authoritative for their respective distributions.
