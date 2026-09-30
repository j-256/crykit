# Development guide

To use the planner, [open the app](https://crycom.lasers.app/). This guide is for running, changing, and verifying the source locally. Read the [project instructions](../AGENTS.md) before contributing.

## Set up the repository

Use Node.js 22.12 or later and npm. Clone the repository, then install the locked dependencies and the privacy hook:

```sh
git clone https://github.com/j-256/crystal-companion.git
cd crystal-companion
npm ci
npm run hooks:install
npm run dev
```

Open the localhost address printed by Vite. The development server binds to `127.0.0.1`.

## Preview the production app

Build and serve the production application to test offline caching:

```sh
npm run build
npm run preview
```

Open the localhost address printed by Vite. Keep using the same origin when entering real records: scheme, host, and port determine which browser database is opened. Export a backup before changing origins or clearing browser storage. Development mode does not install an offline service worker.

Prepare and confirm offline readiness through **Data & settings > Offline & storage**. See [offline use](user-guide.md#use-the-app-offline) for the user workflow.

## Verification

Checks run on the local machine:

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run verify` runs both groups. Browser tests use the production build and include desktop and mobile emulation. They do not establish physical-device installation or verify a phone's native file picker.

The [revision 2 specification](spec-v2.md) defines data boundaries, core workflows, and acceptance gates. [Build mechanics](planner-mechanics.md) documents the supported calculations and their limits.

## Data boundaries and contribution privacy

Keep catalog definitions, personal observations, and planned configurations separate. Preserve explicit unknowns. Use synthetic fixtures when testing; do not commit personal records.

Original workbooks, trackers, personal exports, and private screenshots do not belong in this repository. Commit hooks check staged content for common private artifacts, credentials, machine paths, and unreviewed workflow files. These checks support human review; they do not certify data rights or detect every possible private fact.

Use [GitHub issues](https://github.com/j-256/crystal-companion/issues) for bugs, source corrections, and attribution concerns. Include reproducible steps and synthetic examples. The [correction guide](corrections.md) explains how to export reference corrections separately from playthrough records.

## Interface and artwork

The interface takes its visual cues from Crystal Project's menus: charcoal windows, silver borders, cyan dividers, blue selections, and pixel headings. [Pixel Operator](https://www.dafont.com/pixel-operator.font) by Jayvee Enaguas is a readable substitute for the game's lettering, not a verified match to its original typeface. It ships locally under [CC0](../public/pixel-operator-CC0.txt), with regular weight, disabled ligatures, and fixed type sizes. Body text and compact section headings use system fonts for readable descriptions and forms. The bundled crystal artwork and menu icons ship with the app; decorative artwork does not represent recorded inventory or game progress. Reference entries also show locally bundled wiki sprites and icons where an explicit source mapping exists, with per-file attribution and separate [artwork rights and refresh instructions](catalog-sources.md#sprite-and-icon-snapshot).

## Static hosting and deployment

Serve `dist/` from a secure origin. Hash routes and relative asset URLs support a subdirectory. Offline preparation requires HTTPS or a browser's trusted localhost context. Prepare the production app while connected, then check its offline status before relying on it without a connection. App updates are staged for explicit activation; browser storage still needs external backups.

The hosted app uses an assets-only Cloudflare Worker at `crycom.lasers.app`. The aliases `cp.lasers.app` and `crystal.lasers.app` use HTTP 307 redirects that preserve the request method, path, and query. See [deployment and recovery](deployment.md) for configuration, the public-only CI sequence, and Free-plan limits. Local builds do not need Cloudflare credentials.

Development and verification can run entirely locally. The public repository also verifies changes and deploys main with GitHub Actions. Actions must remain disabled whenever the repository is private; the workflow retains a public-repository guard.

Keep the application license and third-party notices with redistributions. See [credits and licenses](../NOTICE.md).
