# Currency icons

Gold, silver, and copper icons use the original `GUI/Currency` sprite from the fingerprinted Crystal Project Windows 1.6.9 installation. `WindowHelper.DrawCurrency` draws the rectangles `(1, 0, 16, 18)`, `(19, 0, 16, 18)`, and `(37, 0, 16, 18)`, respectively. Extraction preserves the original pixel colors and alpha without screenshot compression or hand-defined masks.

The `uiArtwork` bindings in [the extraction manifest](../../catalog/game-assets.json) retain each source texture hash and crop, and [the runtime manifest](../../catalog/game-artwork.json) resolves the content-addressed PNGs in `src/assets/game-assets/`. Refresh them with `npm run game-assets:update -- --input <game-content-directory>` and verify them with `npm run game-assets:check`. The [game-code evidence](../../catalog/game-code-evidence.json) pins the `currency` symbol and its source file fingerprint. The source texture SHA-256 is `33cdc697633b407693910c77a6e1103ce54ad678ac86d86c58cfae5b0952de35`.

Crystal Project is by Andrew Willman. This game artwork belongs to its respective creators and rights holders and is not covered by the application's AGPL license. See [game artwork credits](../../../NOTICE.md#game-artwork). The extracted icons are bundled locally for offline use; Nintendo Switch appearance parity remains unverified.
