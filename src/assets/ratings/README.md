# Class rating stars

`job-rating.png` is the unchanged `GUI/JobRating` PNG embedded in Crystal Project's `Content/Textures/GUI.dat`. Its SHA-256 is `f5ee30139e40d1aa05677754d1bc01354703676ffcf33f6a413fe330f3321d14`; the containing texture pack has SHA-256 `1918e51946bcc7b8bc8a78e7341bbb3d8e41e9d43fab1e8b1a8db8753e28b034`. The bundled game asset inventory records the texture's source hash and dimensions. The privacy check pins the extracted bytes.

The native `WindowGrowthDetails.DrawRating` uses the filled star at `(2, 2, 28, 28)` and empty star at `(34, 2, 28, 28)`. Each star represents 20 rating points; the game fills half stars in steps of 10. The UI clips this original artwork to render full and half stars on a five-star scale, retaining a numeric accessible label and explicit unknown values. Ratings above the standard scale are displayed numerically. The star presentation changes no catalog definitions, planning calculations, or persisted data. Community wiki star values retain their own provenance and are not promoted to native game facts.

The filled stars use the RGB multiplication in `WindowGrowthDetails.DrawRating`, with colors from `CWindow`: HP `(105, 179, 47)`, MP `(32, 190, 250)`, Strength `(255, 128, 128)`, Vitality `(255, 255, 128)`, Dexterity `(192, 128, 255)`, Agility `(128, 255, 128)`, Mind `(128, 255, 255)`, Spirit `(255, 128, 192)`, Speed `(128, 128, 255)`, and Luck `(255, 192, 128)`. SVG color matrices multiply the original sprite's RGB channels in sRGB space and preserve alpha; empty stars retain their original pixels.

Extract the original PNG using `parseTexturePack` from `scripts/game-assets.mjs`, select the texture whose `path` is `GUI/JobRating`, and write its `bytes` without image processing. The source database is the maintainer-supplied PC installation represented in the game asset inventory; Nintendo Switch parity is unverified.

Crystal Project is by Andrew Willman. This artwork belongs to its respective creators and rights holders and is not covered by the application's AGPL license. See [game artwork credits](../../../NOTICE.md#game-artwork). The asset is bundled locally for offline use.
