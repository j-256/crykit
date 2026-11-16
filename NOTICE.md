# Credits and third-party notices

Crystal Kit is a fan-made toolkit for Crystal Project. It is independent of the game's creators and is not endorsed by them. The original application code is licensed under [AGPL-3.0-only](LICENSE). That license does not grant rights to third-party artwork, reference content, or trademarks.

## Crystal Project data and artwork

[Crystal Project](https://store.steampowered.com/app/1637730/Crystal_Project/) is by Andrew Willman. The game, its source data, and its artwork belong to their respective creators and rights holders. CryKit did not create the game's sprites or other native artwork.

The native gameplay snapshot retains executable and database fingerprints, version evidence, and numeric identities. The [artwork extraction manifest](src/catalog/game-assets.json) retains texture and crop evidence, and the [runtime manifest](src/catalog/game-artwork.json) drives display bindings. These materials retain source-specific rights; the application's AGPL-3.0-only license does not grant rights to the original game assets or data. See [catalog sources](docs/catalog-sources.md).

## Supplemental community guidance

Selected descriptions, practical directions, class-master locations, and the Quintar route retain attribution to the [Crystal Project Wiki contributors](https://crystal-project.fandom.com/wiki/Crystal_Project_Wiki). Wiki-derived text retains its [CC-BY-SA terms](https://www.fandom.com/licensing). Exact page revisions and locators accompany the retained guidance. The application license does not replace those terms. Full wiki and modding-guide snapshots are not included. A small [menu-icon supplement](src/catalog/menu-icon-supplements.json) retains original artwork credits and rights labels; the wiki text license does not grant rights to those images.

Private imported sources retain their own source terms and attribution. For attribution corrections or rights concerns, contact the maintainer through the [repository issues](https://github.com/j-256/crykit/issues).

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
