# CryKit: Builds and more for Crystal Project

Crystal Kit (CryKit, pronounced "cricket") is a local-first planner for **Crystal Project**. Plan classes, equipment, passives, and teams in your browser. Explore build ideas right away, then add character, inventory, and progress tracking whenever you want it.

**[Open Crystal Kit](https://crykit.lasers.app/)** · [User guide](docs/user-guide.md) · [Report a problem](https://github.com/j-256/crykit/issues)

No account or installation is needed. Your saved builds and records stay in your browser, and you can prepare the app for offline use. Crystal Kit is an unofficial fan tool.

## What you can do

- **Plan builds:** search for classes, equipment, and passives, save variations, and compare them without entering everything you own.
- **Share builds and teams:** copy a link to a saved snapshot for someone else to preview and save in their browser. See [share links](docs/share-links.md) for capacity and catalog requirements.
- **Look things up:** browse the bundled reference for items, skills, classes, monsters, and more, with source details alongside the entries.
- **Inspect and edit mods:** look up exact effect names and record IDs, edit a browser draft, and review changes before exporting standard mod JSON. See [Mod Inspector](docs/mod-inspector.md).
- **Check a team:** optionally compare saved builds with recorded character learning and available equipment, including items needed by several party members.
- **Track your game:** record character snapshots, inventory, and progress in separate Playthroughs.

**Progress** has a class-seal mastery board and a **Travel & unlocks** checklist for mount instruments, reusable shrine stones, and capability items such as Treasure Finder, Babel Quintar, fishing rods, and passes. Bundled checklist items display their exact extracted game icons. Mark each item acquired or not acquired for the active Playthrough. Search or filter the checklist to review what remains, and follow **Location & requirements** to its attributed reference. These observations are included in backups and stay separate from inventory quantities and character learning. Imported acquisition values that are unknown or conflicting need explicit confirmation.

## Try your first build

1. **Open the app.** It starts in **Builds** with a labeled sample Playthrough. The example characters and builds let you explore before entering your own records.
2. **Choose New Build.** Search the class, sub-command, equipment, or passive fields and select entries from the results. Fill in as much of the build as you want.
3. **Give it a name if you like.** Choose **Checks & notes**, then add a title or notes under **Build details & notes**. Otherwise, the build is named after its selected class.
4. **Choose Save build.** You can return to it from the build library and save further changes as new checkpoints, keeping earlier versions available.

You can plan with equipment or skills you have not acquired. The planner checks documented build rules and keeps missing or conflicting information visible. Game data may differ by platform, version, or mods; see [reference sources and coverage](docs/catalog-sources.md) for the limits.

Use **Reference** to browse, or press **Cmd+K** on macOS / **Ctrl+K** elsewhere to search across the planner.

The bundled reference uses Windows 1.6.9 game definitions and versioned mod exports. Moonlight Project 2.2 includes its classes, skills, passives, equipment, and supporting definitions. Equipment Expansion and dated Learnable Innate Skills evidence are also included. Base entities use `base:` IDs and mod entities use `mod:` IDs; source metadata records where each fact came from. No game installation is needed to use the app.

Exported zero, false, and null values retain their meaning. Fields that do not apply are omitted from planning details. Missing exports, supplemental acquisition claims, and unrecorded personal choices remain explicit; see the [certainty audit](docs/catalog-sources.md#catalog-certainty-and-identities). Imported catalogs and saved user revisions keep their exact reference pins. Reference entries prefer exact, locally extracted Windows game artwork for source-backed native database identities, use exact bundled cells for Equipment Expansion, and fall back to locally bundled wiki artwork where an explicit mapping exists. These sources retain separate [provenance, rights, and refresh instructions](docs/catalog-sources.md#native-game-artwork-snapshot).

## Track your own game when you are ready

In **Data & settings > Import & backup**, enter a name under **New blank Playthrough** and choose **Create**. Your new Playthrough starts without sample characters, inventory, or progress. Review **Data & settings > Game Setup** for your platform, version, and mods, then record the details you want to track.

These terms describe different parts of your planning:

| Name | What it means |
| --- | --- |
| **Playthrough** | One game save's tracked characters, inventory, progress, and teams. |
| **Game Setup** | The platform, version, mods, and rules used by a build or Playthrough. Builds and Game Setups are shared across Playthroughs. |
| **Scenario** | A team with saved builds assigned to its characters, used to check whether they can use those builds together. |

On a saved build, expand **Can I use this Build now?** to check it against your tracked game. Recording is manual: the app does not connect to Crystal Project, and saving a build leaves your recorded character and inventory unchanged.

## Keep your data safe

Save open forms, then choose **Data & settings > Import & backup > Export backup** to download a copy of your planner data. Use that file to recover your records or move them to another browser or device.

Mod Inspector originals and drafts have separate downloads and are not included in planner backups. Export them from **Tools > Mod Inspector** before clearing browser storage or moving to another browser.

**Browser storage is not a backup.** Clearing site data can remove your records, and another browser or app address has separate storage. There is no automatic cloud sync or telemetry. Backup files can contain private notes and source files; keep them private. Restoring a backup replaces all planner data in the destination browser after confirmation. See [backups and recovery](docs/data-formats.md).

For offline use, open **Data & settings > Offline & storage** while connected. Choose **Prepare for offline use** if needed, and wait for **Offline ready** before disconnecting.

## Go further

| I want to... | Guide |
| --- | --- |
| Explore builds, teams, character history, and search | [User guide](docs/user-guide.md) |
| Understand stat estimates and supported rules | [Build mechanics](docs/planner-mechanics.md) |
| Export versioned character formulas and native numeric data | [Calculation package](docs/calculations.md) |
| Use mods or import custom classes | [Mods](docs/mods.md) and [Crystal Edit imports](docs/crystal-edit.md) |
| Decode IDs and edit mod JSON | [Mod Inspector](docs/mod-inspector.md) |
| Import Learn-menu screenshots | [Screenshot learning](docs/screenshot-learning.md) |
| Correct a reference entry | [Reference corrections](docs/corrections.md) |
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
