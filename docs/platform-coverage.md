# Game platform coverage

The fingerprinted Windows and macOS Crystal Project 1.6.9.0 builds compared on 2026-10-05 have matching native game data and calculation code. For shared gameplay facts from these builds, cite **Crystal Project 1.6.9.0** or **PC 1.6.9.0**; a Windows-specific qualifier is redundant. Retain the version and reviewed source scope.

## Verified shared content

The bundled databases match byte-for-byte, including classes, equipment, abilities, passives, genders, monsters, difficulty settings, balance patches, recipes, and system configuration. Audio, artwork, fonts, and shaders also match byte-for-byte. The arena, field, and title world archives have identical entry sets and extracted contents. Their complete archive bytes match after normalizing only ZIP date/time fields; different container hashes do not indicate different maps or world interactions.

The managed game executables were decompiled with ILSpy 11.1.0.9782 and identical dependency resolution. The comparison found matching combat/stat calculations, learning rules, mod compilation, save serialization, and the remaining gameplay code. Apparent differences caused by resolving different framework assemblies disappeared when both inputs used the same dependencies. Corresponding Crystal Edit files also match; a remembered editor configuration existed only in the Windows installation and does not establish a platform feature difference.

This establishes a shared baseline for CryKit's native catalog, calculations, artwork, map, acquisition, learning, and other reviewed gameplay facts in these exact builds. It does not establish Nintendo Switch, Linux, other game versions, randomizer configurations, or enabled mod combinations. The separate maintainer-approved calculation compatibility assumption for PC 1.6.6 remains an assumption; see [calculation compatibility](calculations.md#compatibility-and-maintenance).

## Source fingerprints

These SHA-256 values identify the compared inputs. The macOS executable below is the managed `Crystal Project.exe` inside the application's resources, separate from its native launcher.

| Input | SHA-256 |
| --- | --- |
| Windows managed game executable | `36f7d413160a4deee36b47fc6ac534e87cadb6f23f57337d4630ec99cedb14e6` |
| macOS managed game executable | `7ceb80f9ebde6a03c48558a5a3087e20f6dd1fbb1c92300468bad35c5de141e2` |
| Both `Content/Database/system.dat` files | `aeb36700a47795c8bda8ba3cbdb0ab9b131f4b56b1136f3dd5decf5ebb59178f` |
| Windows `Content/Worlds/field.dat` archive | `a93405dccaf04289f84d38be5b994d62b12e207afc8762d0bf79086023401107` |
| macOS `Content/Worlds/field.dat` archive | `b18c4e50a7dd1d96e115e2043a6e2892d114232016939a90846f70f34e1efe2d` |

The [native game snapshot](../src/catalog/native-game-data.json), [game-code evidence](../src/catalog/game-code-evidence.json), and [map manifest](../src/catalog/world-map.json) retain their original Windows extraction provenance and immutable identities. Shared gameplay scope does not make the executable hashes interchangeable or authorize replacing stored source metadata. Extractors with pinned Windows fingerprints still require those exact inputs; accepting macOS inputs requires a separately reviewed fingerprint profile. This documentation does not change programmatic Game Setup applicability checks or saved platform values.

To reproduce the comparison, verify executable versions and hashes, hash corresponding databases and assets, compare every extracted world-archive entry, and decompile both managed executables with identical dependency resolution. Review every code difference and retain platform-specific source hashes. A matching version label or system database alone is insufficient to establish whole-build equivalence. Keep installation bytes, decoded proprietary data, decompiled source, and machine-local paths outside the repository.

## Platform-specific behavior

Platform labels remain useful for default save directories, installation layout, native launcher architecture and runtime libraries, DPI setup, window focus/input, MP3 decoding, and Steam initialization or native ABI details. These were the observed executable and packaging differences. The macOS launcher is Intel x86_64 and bundles Mono and macOS libraries; its packaged Vulkan/MoltenVK components do not establish which graphics backend runs.

This was a static file and code comparison. Runtime performance, rendering, audio playback, controller behavior, cross-platform save round-trips, and mod execution were not tested. Shared game data and calculation code do not establish identical runtime behavior.
