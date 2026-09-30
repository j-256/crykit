# Equipment type icons

`equipment-types.png` preserves the original `Icon/SystemB` PNG bytes from Crystal Project PC 1.6.9.0. Its SHA-256 is `0e2066d5776e5a23d9fb4f9291a7d8a07f22f7353ec352882fb30af2fb20ee9e`. The source `Content/Textures/Icon.dat` pack has SHA-256 `fa47ea27cf0edd6b571f2349e1e0041528f8dd128b626315cb9a6096a6ce09e8`.

The game's `CWindow.EQUIP_TYPE_ICON_INDEX` maps medium headgear to cell 42 and medium armor to cell 43. `WindowHelper.DrawIcon` uses seven columns, a 34-pixel stride, a two-pixel inset, and 32-pixel cells. The application crops those cells at display time without modifying the source pixels.

This is presentation artwork, not evidence of Switch mechanics or mod compatibility. Copyright belongs to Crystal Project's rights holders; no separate license grant is asserted. See the repository NOTICE for the project's use of game artwork.
