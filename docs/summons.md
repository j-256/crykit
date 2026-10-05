# Summon reference evidence

The Summons Progress board uses the Summoner ability nodes from the bundled [class-tree identities](../src/catalog/class-tree-identities.json). Rows and columns are preserved after removing the passive row. The starting skill Pinga is included, stays gold, and cannot be toggled. The board records only Playthrough skill availability; gold is the checklist's unlocked state and does not assert that any character learned the skill.

The bundled 1.6.9.0 job, ability, and monster records establish the skill identities, the starting skill's default availability, and exact named boss artwork. The deity titles below are corroborated by challenge dialogue in the owned Windows world artifact `Content/Worlds/field.dat` (SHA-256 `a93405dccaf04289f84d38be5b994d62b12e207afc8762d0bf79086023401107`). World regions use `(x, z)` indices and entity entries inside their nested ZIP archives. World bytes are not bundled or requested at runtime.

| Summon | Display title | Monster ID | Dialogue locator |
| --- | --- | --- | --- |
| Pinga | Healing | 96 | No challenge dialogue; presentation title from `Monster/Sumn_Healing` |
| Pah | Reflection | 97 | Region `(38, -14)`, `y5e.dat`, `SReflect_Summon` |
| Shaku | Fire | 102 | Region `(7, 0)`, `y6e.dat`, `SFire_Summon` |
| Pamoa | Ice | 91 | Region `(31, -26)`, `y13e.dat`, `SIce_Summon` |
| Niltsi | Wind | 93 | Region `(23, -22)`, `y11e.dat`, `SWind_Summon` |
| Ioske | Earth | 92 | Region `(6, -14)`, `y7e.dat`, `SEarth_Summon` |
| Guaba | Thunder | 94 | Region `(-4, -21)`, `y5e.dat`, `SThunder_Summon` |
| Coyote | The Deep | 95 | Region `(-4, 12)`, `y3e.dat`, `SWater_Summon` |
| Tira | Shadow | 98 | Region `(45, -18)`, `y8e.dat`, `SShadow_Summon` |
| Juses | Life | 99 | Region `(42, 6)`, `y7e.dat`, `SLife_Summon` |

The world container has a version/flag prefix followed by a ZIP archive. Its `field.dat` entry contains length-prefixed settings and entity-ledger data, a region offset table, and nested region ZIP bytes. The loader structure is corroborated by `ZLookup.LoadBinary` and `ZCache.TryLoadBinary`; entity text uses `EntitySerializer`. These locators preserve the distinction between deity titles and damage elements: Coyote's challenge says The Deep, and Juses's says Life. Pinga's Healing title is a display convention based on its asset identity, not a claim of a boss challenge.

The owned screenshot corroborates the board shape. It does not establish game-version or mod parity. The shared Windows/macOS 1.6.9.0 baseline is the native data scope; Switch and mod applicability remain unverified. The checklist deliberately supports independent manual marks and does not enforce class, boss, LP, or learning prerequisites.

Unlock marks use the existing versioned Playthrough Progress records and their `unlocked` knowledge field. Pinga's availability comes from its starting-skill definition and is always shown as unlocked without creating a personal observation. Any older imported Pinga observation remains intact in storage and backups. For the other summons, missing records display gray, and imported unknown, conflicting, and not-applicable values remain unconfirmed until explicitly toggled. Saves preserve existing record IDs, exact subject pins, provenance, and secondary observations. The native backup and storage formats remain unchanged, so older saved data opens without a new migration.
