# Platform coverage

Gameplay references use **PC** for Windows, macOS, and Linux. Windows/macOS parity is verified below. Linux parity for the same game versions is a maintainer-approved assumption; no Linux build was compared. Steam [lists Linux support](https://store.steampowered.com/app/1637730/Crystal_Project/). Platform-specific runtime behavior remains outside this shared gameplay scope.

## Crystal Project 1.7.0.1

The Windows and macOS Steam builds compared on 2026-11-16 have matching native gameplay databases, embedded textures, and calculation, save, and mod interpretation code. The bundled catalog uses the fingerprinted Windows extraction. Gameplay claims within this reviewed scope can use **Crystal Project 1.7.0.1** or **PC 1.7.0.1**; executable fingerprints and platform-specific behavior retain their platform labels. The [comparison receipt](platform-coverage-1.7.0.1.json) records the inputs and equality checks.

Corresponding database and texture-pack files match byte-for-byte. Extracted world-archive member names and bytes match; the complete archives match after normalizing only ZIP date/time fields. Controlled decompilation with identical dependency resolution leaves differences in audio decoding, save-directory selection, window/input handling, Steam integration, and startup. These platform integration differences do not change the reviewed gameplay calculations. Shader membership was not established as identical: `Shaders/EffectClear.fxb` was observed only in macOS Content. Runtime rendering, audio, input, and performance parity were not tested.

| Compared input | SHA-256 |
| --- | --- |
| Windows managed game executable | `bd1ad18037edaa96250c52446e83c4cbc44cff0e833edbeaf570ed328748cff4` |
| macOS managed game executable | `12c4ec6813d65bac43eca34ad1605a2c6f0241b0d4312feaadbe7d99b9a5d589` |
| Both `Content/Database/system.dat` files | `8ade3dee6bb3f23ea8ca6424677368c998b26b2afdf0c549805665695f19f7bb` |

Compared with 1.6.9.0, character growth and resting stat arithmetic are unchanged. Actor current/missing-resource damage modifiers use captured turn resource values in 1.7.0.1; exact earlier Game Setups retain their earlier current-resource semantics. The supported save header adds its home-point identity and stores appearance-class metadata separately from the gameplay class. Editor format 35 adds localization fields while retaining the reviewed numeric planning conversions. See [calculation coverage](calculations.md), [save editing](save-editor.md), and [Crystal Edit imports](crystal-edit.md).

This comparison does not establish Switch, Linux, other versions, randomizer configurations, or enabled mod combinations. Source identities and saved applicability remain exact; shared display labels do not rewrite extraction provenance or saved Game Setups.

## Nintendo Switch 1.6.6 gameplay baseline

CryKit uses the inspected Steam `console` branch, PC 1.6.6.0, as its maintainer-approved gameplay proxy for Nintendo Switch 1.6.6. The [comparison receipt](platform-coverage-console-1.6.6.json) pins the macOS console-branch executable and Windows 1.7.0.1 reference. This establishes the practical Switch baseline without claiming inspection of a native console executable or console runtime behavior. Only Switch versions 1.6.6 and 1.6.6.0 are admitted; an unknown or later Switch version remains unsupported until reviewed.

Equipment, item, monster, passive, status, recipe, difficulty, gender, biome, troop, actor, animation, voxel, and encounter records match. Ability and class records add disabled `HideIfUnusable` and `IsNotCrystalJob` fields in 1.7, including corresponding balance-mode patches. Battle and field constants match. Quintar quest logic matches in full. Member base-stat and monster stat arithmetic match; member equipment aggregation adds paired-weapon tag support after 1.6.6. One bundled native catalog supplies these shared definitions.

Version differences remain explicit:

- Actor current/missing-resource damage uses current HP/MP/AP in 1.6.6 and captured turn-start resources in 1.7.0.1
- `BonusDoubledWhenPaired` doubles matching accessories in 1.6.6; PC 1.6.7 extends it to weapons. The native tagged items are Ogre Ball and Earring, both accessories
- The Babel Quintar randomizer recovery pickup near Dione Shrine appears in PC 1.6.7 and is absent from the 1.6.6 baseline. The terrain matches; the other changed world interaction only corrects dialogue
- The 1.6.6 reader accepts save headers through format 28; 1.7 writes format 29. Saves written by 1.7 cannot be loaded by that earlier reader

The [developer's PC notes](https://www.riverrunninggames.com/crystalproject/patchnotes.html) and [Switch notes](https://www.riverrunninggames.com/crystalproject/patchnotes-ns.html) distinguish release features and fixes. Later mod features do not become available on Switch through this proxy. Extraction fingerprints and stored source identities retain their original platforms and versions.

## Historical Crystal Project 1.6.9.0 comparison

The fingerprinted Windows and macOS Crystal Project 1.6.9.0 builds compared on 2026-10-05 have matching native game data and calculation code. For shared gameplay facts from these builds, cite **Crystal Project 1.6.9.0** or **PC 1.6.9.0**; a Windows-specific qualifier is redundant. Retain the version and reviewed source scope.

### Verified shared content

The bundled databases match byte-for-byte, including classes, equipment, abilities, passives, genders, monsters, difficulty settings, balance patches, recipes, and system configuration. Audio, artwork, fonts, and shaders also match byte-for-byte. The arena, field, and title world archives have identical entry sets and extracted contents. Their complete archive bytes match after normalizing only ZIP date/time fields; different container hashes do not indicate different maps or world interactions.

The managed game executables were decompiled with ILSpy 11.1.0.9782 and identical dependency resolution. The comparison found matching combat/stat calculations, learning rules, mod compilation, save serialization, and the remaining gameplay code. Apparent differences caused by resolving different framework assemblies disappeared when both inputs used the same dependencies. Corresponding Crystal Edit files also match; a remembered editor configuration existed only in the Windows installation and does not establish a platform feature difference.

This establishes a shared baseline for CryKit's native catalog, calculations, artwork, map, acquisition, learning, and other reviewed gameplay facts in these exact builds. It does not establish Nintendo Switch, Linux, other game versions, randomizer configurations, or enabled mod combinations. The separate [console-branch comparison](#nintendo-switch-166-gameplay-baseline) supplies the PC and Switch 1.6.6 baseline.

### Source fingerprints

These SHA-256 values identify the compared inputs. The macOS executable below is the managed `Crystal Project.exe` inside the application's resources, separate from its native launcher.

| Input | SHA-256 |
| --- | --- |
| Windows managed game executable | `36f7d413160a4deee36b47fc6ac534e87cadb6f23f57337d4630ec99cedb14e6` |
| macOS managed game executable | `7ceb80f9ebde6a03c48558a5a3087e20f6dd1fbb1c92300468bad35c5de141e2` |
| Both `Content/Database/system.dat` files | `aeb36700a47795c8bda8ba3cbdb0ab9b131f4b56b1136f3dd5decf5ebb59178f` |
| Windows `Content/Worlds/field.dat` archive | `a93405dccaf04289f84d38be5b994d62b12e207afc8762d0bf79086023401107` |
| macOS `Content/Worlds/field.dat` archive | `b18c4e50a7dd1d96e115e2043a6e2892d114232016939a90846f70f34e1efe2d` |

The [native game snapshot](../src/catalog/native-game-data.json), [native mechanic evidence](../src/catalog/native-mechanics.json), and [map manifest](../src/catalog/world-map.json) retain their original Windows extraction provenance and immutable identities. Shared gameplay scope does not make the executable hashes interchangeable or authorize replacing stored source metadata. Extractors with pinned Windows fingerprints still require those exact inputs; accepting macOS inputs requires a separately reviewed fingerprint profile. This documentation does not change programmatic Game Setup applicability checks or saved platform values.

To reproduce the comparison, verify executable versions and hashes, hash corresponding databases and assets, compare every extracted world-archive entry, and decompile both managed executables with identical dependency resolution. Review every code difference and retain platform-specific source hashes. A matching version label or system database alone is insufficient to establish whole-build equivalence. Keep installation bytes, decoded proprietary data, decompiled source, and machine-local paths outside the repository.

### Platform-specific behavior

Platform labels remain useful for default save directories, installation layout, native launcher architecture and runtime libraries, DPI setup, window focus/input, MP3 decoding, and Steam initialization or native ABI details. These were the observed executable and packaging differences. The macOS launcher is Intel x86_64 and bundles Mono and macOS libraries; its packaged Vulkan/MoltenVK components do not establish which graphics backend runs.

This was a static file and code comparison. Runtime performance, rendering, audio playback, controller behavior, cross-platform save round-trips, and mod execution were not tested. Shared game data and calculation code do not establish identical runtime behavior.
