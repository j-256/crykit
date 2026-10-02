# Equipment type icons

`equipment-types.png` preserves the original `Icon/SystemB` PNG bytes from Crystal Project PC 1.6.9.0. Its SHA-256 is `0e2066d5776e5a23d9fb4f9291a7d8a07f22f7353ec352882fb30af2fb20ee9e`. The source `Content/Textures/Icon.dat` pack has SHA-256 `fa47ea27cf0edd6b571f2349e1e0041528f8dd128b626315cb9a6096a6ce09e8`.

The game's `CWindow.EQUIP_TYPE_ICON_INDEX` maps shields to cell 39, heavy helmets to cell 40, heavy armor to cell 41, medium headgear to cell 42, medium armor to cell 43, light hats to cell 44, and light armor to cell 45. `WindowHelper.DrawIcon` uses seven columns, a 34-pixel stride, a two-pixel inset, and 32-pixel cells. The application crops those cells at display time without modifying the source pixels.

The reviewed `Sang/Window/CWindow.cs` source has SHA-256 `cad72d04c122f19c2987ce156784a153ae494315945b2f725048a3b3d126c17c`. Equipment type ordering is recorded in `Sang/SangData/SangDataEnums/EquipmentType.cs`, whose fingerprint is retained in the [game-code evidence](../../catalog/game-code-evidence.json). These mappings use the executable identified by the native artwork manifest.

This is presentation artwork, not evidence of Switch mechanics or mod compatibility. Copyright belongs to Crystal Project's rights holders; no separate license grant is asserted. See the repository NOTICE for the project's use of game artwork.
