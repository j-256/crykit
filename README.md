# CryKit: Buildcrafting and progress for Crystal Project

Crystal Kit (CryKit, pronounced "cricket") is a local-first build planner and progress tracker for **Crystal Project**. Plan classes, equipment, passives, growth, and teams in your browser. Track class seals, travel unlocks, summons, and Quintar breeding, or explore the bundled reference and world map. Character and inventory records are optional.

**[Open Crystal Kit](https://crykit.lasers.app/)** · [User guide](docs/user-guide.md) · [Report a problem](https://github.com/j-256/crykit/issues)

No account or installation is needed. Your saved builds and records stay in your browser, and you can prepare the app for offline use. Crystal Kit is an unofficial fan tool.

Rough drafts are available on the separate [preview site](https://preview.crykit.lasers.app/). Preview records stay separate from the main site's browser data. See [preview deployment](docs/deployment.md#draft-preview) to publish a draft from a task checkout.

## What you can do

- **Plan builds:** mix classes, sub-commands, equipment, and passives, save variations, and compare them without entering everything you own.
- **Explore calculated stats:** adjust level, class growth, and gender to compare supported loadout totals, including enabled mod overrides and added bonus profiles. Missing inputs and unsupported rules stay explicit. See [calculation scope](docs/planner-mechanics.md) and [mod calculation boundaries](docs/mod-calculations.md).
- **Share builds and teams:** copy a link to a saved snapshot for someone else to preview and save in their browser. The snapshot is carried in the URL, so links can exceed chat message limits. See [share links](docs/share-links.md) for transfer options and catalog requirements.
- **Track progress:** use the class-seal board, Travel & unlocks checklist, Summons board, and Golden Quintar breeding guide. Marks save to the selected Playthrough and stay separate from inventory and character learning. See [progress tracking](docs/user-guide.md#track-inventory-and-progress).
- **Look things up:** browse items, skills, class learn trees, monsters, and more. Native effects and stats lead the reference; item and equipment pages collect supported routes and reward conditions under **How to obtain**. Guide notes stay readable, with **Sources** icons for external claims and uncertain values.
- **Explore the world:** pan and zoom through the native Windows world map, find chests, NPCs, bosses, resources, and landmarks, and preview bundled or imported mod placements. See [the world map guide](docs/user-guide.md#explore-the-world-map).
- **Manage mods:** browse bundled and imported versions, import updates, edit full project JSON, and follow links to Steam Workshop. Mods without a source file retain catalog entries and support manual observations. See [Mods](docs/mods.md) and [the editor workspace](docs/mod-inspector.md).
- **Edit game saves:** open any native-supported save format, adjust the party and inventory, review a preset, and download an edited copy locally. See [save editing and compatibility](docs/save-editor.md) for game-rule coverage.
- **Check a team:** optionally compare saved builds with recorded character learning and available equipment, including items needed by several party members.
- **Record your game:** keep character snapshots, learning, and inventory in separate Playthroughs. Learn-menu screenshot imports run locally and require review before saving.

## Try your first build

1. **Open the app.** Choose the mods you use from a searchable list, use the optional starter selection, or skip for now. Selected revisions are added to Reference and enabled in your starting Game Setup. It starts in **Builds** with a labeled sample Playthrough. The example characters and builds let you explore before entering your own records.
2. **Choose New Build.** Search the class, sub-command, equipment, or passive fields and select entries from the results. Fill in as much of the build as you want.
3. **Give it a name if you like.** Enter **Build title** at the top of the sheet. Choose **Checks & notes** for play notes and a checkpoint name. Otherwise, the build is named after its selected class.
4. **Choose Save build.** You can return to it from the build library and save further changes as new checkpoints, keeping earlier versions available.

You can plan with equipment or skills you have not acquired. The planner checks documented build rules and keeps missing or conflicting information visible. Game data may differ by platform, version, or mods; see [reference sources and coverage](docs/catalog-sources.md) for the limits.

Expand **Loadout > Stats & growth** to adjust level and class growth. If missing setup information prevents calculations, choose **Review Game Setup**. Selecting content from a mod that is not enabled asks you to enable it for that Build; adding a mod to the library alone does not enable it. See [Mods and Game Setups](docs/mods.md).

Use **Reference** to browse, or press **Cmd+K** on macOS / **Ctrl+K** elsewhere to search across the planner.

The bundled reference combines Windows PC 1.6.9 game definitions, versioned mod exports, and attributed community evidence. Fresh profiles browse the native base plus the mods they choose. Moonlight Project, Equipment Expansion and dated Learnable Innate Skill are available through the same library as other bundled projects. Source versions stay visible, and Switch or mod-pack parity is not assumed. No game installation is needed to use the app. See [reference sources and coverage](docs/catalog-sources.md) for provenance, artwork, and unresolved details.

## Track your own game when you are ready

Choose **Data & settings > Import & backup > New blank Playthrough**, enter a name, and choose **Create**. You can also start from **Playthrough > New Playthrough**. Your new Playthrough starts without sample characters, inventory, or progress. Builds and Teams remain available independently; turn off **Show sample Builds** in the Build library to hide examples.

Create or edit game version, difficulty, and mods under **Data & settings > Saved setups**. To use a saved revision for tracking, return to **Playthrough**, choose **Game Setup to apply**, and select **Apply to** followed by your Playthrough's name. Saving a setup alone does not apply it to a tracked game.

These terms describe different parts of your planning:

| Name | What it means |
| --- | --- |
| **Playthrough** | One game save's tracked characters, inventory, progress, and party plans. |
| **Game Setup** | Base game version, difficulty, and mods used by a saved build checkpoint or Playthrough. |
| **Team** | Four build checkpoints saved together for planning and sharing, independent of characters. |
| **Party plan** | Builds assigned to four tracked characters for readiness and shared inventory checks. |

On a saved build, expand **Use with Tracking** to check it against your tracked game. Recording is manual: the app does not connect to Crystal Project, and saving a build leaves your recorded character and inventory unchanged.

## Keep your data safe

Save open forms, then choose **Data & settings > Import & backup > Export backup** to download a copy of your planner data. Use that file to recover your records or move them to another browser or device.

Mods saved to the Mod library and their original source files are included in planner backups. Editor workspace originals and working drafts have separate downloads; export those drafts from **Mods > Editor workspace** before clearing browser storage or moving to another browser.

Game saves and save-specific mod definitions opened in **Save editor** stay in memory for that tab. CryKit automatically matches bundled Crystal Edit definitions and requests manual JSON only for exceptions. Supported disabled-mod residue can be reviewed for removal without changing the save's game mode. Download edited saves separately before leaving or reloading; planner backups do not include the opened saves or session-only manual definitions.

**Browser storage is not a backup.** Clearing site data can remove your records, and another browser or app address has separate storage. There is no automatic cloud sync or telemetry. Backup files can contain private notes and source files; keep them private. Restoring a backup replaces all planner data in the destination browser after confirmation. See [backups and recovery](docs/data-formats.md).

For offline use, open **Data & settings > Offline & storage** while connected. Choose **Prepare for offline use** if needed, and wait for **Offline ready** before disconnecting.

The same section offers **Apply app update** for a staged update and **Refresh app** to download fresh app files while preserving saved records and editor drafts. Save open forms first. See [offline use and updates](docs/user-guide.md#use-the-app-offline).

## Go further

| I want to... | Guide |
| --- | --- |
| Explore builds, teams, character history, and search | [User guide](docs/user-guide.md) |
| Track seals, travel unlocks, summons, or Quintar breeding | [Progress guide](docs/user-guide.md#track-inventory-and-progress) |
| Find locations, item acquisition routes, and mod placements | [World Map](docs/user-guide.md#explore-the-world-map) and [Reference](docs/user-guide.md#browse-reference-data) |
| Understand stat estimates and supported rules | [Build mechanics](docs/planner-mechanics.md) |
| Understand reference facts, sources, and platform coverage | [Catalog sources](docs/catalog-sources.md) and [native reference projections](docs/native-reference-facts.md) |
| Export versioned character/combat rules or read their equations | [Calculation package](docs/calculations.md), [human-readable reference](docs/calculation-reference.md) |
| Use mods or import custom classes | [Mods](docs/mods.md) and [Crystal Edit imports](docs/crystal-edit.md) |
| Decode IDs and edit mod JSON | [Mods and the editor workspace](docs/mod-inspector.md) |
| Edit a Crystal Project save | [Save editor](docs/save-editor.md) |
| Import Learn-menu screenshots | [Screenshot learning](docs/screenshot-learning.md) |
| Report incorrect reference data | [GitHub issues](https://github.com/j-256/crykit/issues) |
| Work on the app or host a copy | [Development](docs/development.md) and [deployment](docs/deployment.md) |

## Run locally

If you prefer a local copy, install Node.js 22.12 or later and npm, then run:

```sh
git clone https://github.com/j-256/crykit.git
cd crykit
npm ci
npm run dev
```

Open the localhost address printed by Vite. For offline caching, use the [production build instructions](docs/development.md#preview-the-production-app). Local builds do not need Cloudflare credentials.

## Feedback and license

Found a bug or a reference mistake? [Open an issue](https://github.com/j-256/crykit/issues) with steps to reproduce it and an example using made-up records. Keep personal backups, imports, and playthrough screenshots out of public issues.

Original application code is licensed under [AGPL-3.0-only](LICENSE). Game artwork, wiki content, fonts, and dependencies retain their separate rights. See [credits and third-party notices](NOTICE.md), also available in **Data & settings > Credits & licenses**.
