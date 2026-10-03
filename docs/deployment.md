# Public deployment and recovery

The public application is [crykit.lasers.app](https://crykit.lasers.app/). Its source is [j-256/crykit](https://github.com/j-256/crykit). Personal data stays in each browser; deployments contain the static application, public reference catalog, artwork, OCR resources, and license notices.

## Deployment contract

`wrangler.jsonc` owns the assets-only Worker `crykit` and the `crykit.lasers.app` Custom Domain. There is no Worker script, server database, account system, or upload endpoint. Both workers.dev and preview URLs are disabled. The application uses hash routes, so arbitrary missing asset paths should return 404 instead of the application shell. `public/_headers` supplies the content security policy and cache headers.

Use Node.js 24, install with `npm ci`, then run:

```sh
npm run verify
npm run deploy:dry-run
```

Install Chromium with `npx playwright install chromium` before browser verification on a fresh machine. A dry run validates the built `dist/` tree and does not publish it. Supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the environment. Keep credentials out of source and browser build variables.

For feature publication, install the repository hooks with `npm run hooks:install`, then commit and synchronize before running `npm run verify`. The pre-push hook requires complete desktop/mobile verification for each published Git tree; focused tests and `npm run check` alone do not satisfy it. See [publication verification](development.md#publication-verification) for shared route assertions, cache invalidation, and linked-worktree behavior. Protected PR verification remains required independently of local evidence.

Routine releases upload assets with `wrangler versions upload` and activate that exact version at 100% with `wrangler versions deploy`. They need only Workers Scripts Write for the existing Worker and leave its routes, Custom Domain, and other triggers unchanged. GitHub Actions reads the version ID from Wrangler's structured upload output and rejects missing, ambiguous, or unexpected upload records before deployment. It never chooses a version by recency. See Cloudflare's [version deployment documentation](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/) and [Workers authorization requirements](https://developers.cloudflare.com/workers/authorization/workers/).

Initial provisioning or intentional routing changes use `npm run deploy`, which also reconciles the Custom Domain in `wrangler.jsonc`. That operation additionally requires Zone Workers Routes Write for the affected zone. Keep those permissions with the operator managing hosting; the repository Actions token needs only Workers Scripts Write. Changing trigger configuration in source alone does not apply it through the routine release workflow.

## Public-only GitHub Actions

Keep repository Actions disabled while a repository is private. Prepare and verify changes locally, push them with Actions disabled, make the repository public, and confirm GitHub reports public visibility before enabling Actions or dispatching the workflow. Disable Actions before making a public repository private. Private forks must leave Actions disabled.

The reviewed `.github/workflows/deploy.yml` runs only for public repositories. Pull requests run verification, the deployment dry run, and every browser shard, then report the stable `release-ready` aggregate check. The `Protect main releases` repository ruleset requires a pull request with strict `release-ready` status before `main` can advance, permits rebase merges, requires linear history, blocks deletion and force pushes, requires no approving review, and has no bypass actors. This keeps solo releases quick while preventing direct pushes or stale verification from putting unverified source on `main`.

Pushes to protected `main` and manual runs on `main` rebuild the accepted tree, repeat deterministic verification and the deployment dry run, then deploy that exact artifact without rerunning the already-required browser matrix. This avoids a post-merge browser timing failure leaving `main` newer than production. Deployment uses the repository Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and is limited to `j-256/crykit`; change that explicit owner guard when intentionally transferring hosting. Actions are pinned by commit, use a standard Linux runner, and receive read-only repository permissions. Deployment credentials are supplied only to the deployment step. Runs for a ref are serialized to avoid overlapping publication.

GitHub's [Actions billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions) describes free standard hosted-runner use for public repositories. A public repository does not make larger runners or other billed services free.

Pull request verification builds the application once, checks deployment limits, and passes that artifact to desktop and mobile browser shards. Desktop runs the complete scenario set; mobile runs the explicitly tagged responsive, touch, and representative workflow coverage described in the [development guide](development.md#verification). The matrix allocates more shards to desktop and distributes independent tests at test level, with one worker per shard. Browser assertions keep their normal timeouts. Queued-save tests use explicit extended budgets for draining their controlled workloads. Every browser job retains a JSON timing report, and failed jobs also retain synthetic traces and screenshots for diagnosis. GitHub annotations expose failures as they occur. The protected `main` deployment builds its own artifact from the accepted commit after deterministic checks pass. Application, timing, and failure artifacts expire after one day to bound storage use.

## Hostnames and redirects

Cloudflare manages TLS and DNS for the canonical Custom Domain. The `lasers.app` zone separately owns the aliases:

| Hosts | Behavior | Owner |
| --- | --- | --- |
| `crykit.lasers.app` | Static application | Worker Custom Domain in `wrangler.jsonc` |
| `crycom.lasers.app`, `cp.lasers.app`, `crystal.lasers.app`, `crystal-companion.lasers.app`, `crystalcompanion.lasers.app` | HTTP 307 to the canonical host, preserving method, path, and query | Single Redirect rule `crykit_aliases` plus originless proxied DNS |

The redirect rule matches `http.host in {"crycom.lasers.app" "cp.lasers.app" "crystal.lasers.app" "crystal-companion.lasers.app" "crystalcompanion.lasers.app"}`, uses target expression `concat("https://crykit.lasers.app", http.request.uri.path)`, status `307`, and `preserve_query_string: true`. Alias DNS is a proxied `AAAA` record with content `100::`, reserved for discard-only use. No application Worker owns the aliases. Do not replace this with a 301 or 302, which can change the request method. A preserved POST reaches a static destination that does not accept writes; the redirect itself does not promise a successful POST response.

Keep these existing addresses and their HTTPS support operational throughout the name transition, with no automatic expiration. Retiring an alias requires a separate maintainer decision. Each alias redirects directly to the canonical app without an intermediate old hostname.

The exact-host Configuration Rule `crykit_disable_rum` matches `crykit.lasers.app` and sets `disable_rum: true`, preventing automatic Cloudflare Web Analytics injection. Maintain this independently of Worker deployments so the application's no-telemetry behavior remains true. Use Cloudflare Fleet to inspect and plan changes to the zone rules before applying them.

## Free-plan compatibility

Verified against Cloudflare documentation on 2026-10-03: [static asset requests are free and unlimited](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). The [Workers Free static asset limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets) are 20,000 files per Worker version and 25 MiB per file. `npm run check:assets` measures every built file, prints the file count, total bytes, and largest file, and rejects either limit exceedance before dry runs and deployments. A production build measured on that date, including the bundled world map and mod sources, has approximately 2,200 files totaling 62 MiB, with its largest file about 12 MiB. These measurements fit the per-version file count and per-file size limits; total asset bytes have no corresponding limit here. Reproduce the measurements with `npm ci && npm run build && npm run check:assets` after dependency or catalog changes.

The aliases share one [Single Redirect rule](https://developers.cloudflare.com/rules/url-forwarding/#availability), against the Free allowance of 10 per zone. Analytics suppression uses one [Configuration Rule](https://developers.cloudflare.com/rules/configuration-rules/#availability), also against a Free allowance of 10 per zone. These quotas were verified on 2026-10-03. Other applications share the zone quotas, so inspect usage before adding rules. These requirements fit Free and do not require a Paid Worker. If assets outgrow Free, reduce or split the bundled material before release, or document and review a Paid requirement; successful deployment on a Paid account does not prove Free compatibility.

## Verification and recovery

After deployment, inspect the Worker, serving version, Custom Domain, and disabled workers.dev/preview settings. Check the app in a fresh desktop and mobile browser, open Reference artwork and Credits & licenses, prepare it for offline use, and reload while offline. Confirm the network contains no analytics injection or external game-data requests. Probe every alias with GET and POST on a path with a query, and verify HTTP 307 plus the exact destination. A browser hash route should survive alias navigation.

For a failed release, rebuild a known-good source revision and deploy its verified `dist/` tree, or use Wrangler's deployment rollback after inspecting the serving versions. Rollback of hosted files does not restore or migrate a user's browser database. App updates wait for explicit activation; cache cleanup retains the active and previous build for the same installation, leaving other installations and IndexedDB alone. Save drafts and reload older tabs after an update. Export personal backups before changing browser origins or clearing site storage.

Cloudflare redirects `index.html` to the directory URL. The service worker copies redirected cached HTML responses before returning them to navigations, which reject a response with a redirect history. The subpath browser fixture reproduces that redirect and verifies updates and offline reloads with saved observations.

Recovery requires the repository, lockfile, Actions configuration and secrets, Cloudflare account access, Custom Domain, alias DNS, redirect rule, and analytics Configuration Rule. These are separate state: restoring only a Git checkout does not restore zone settings or credentials. Source publication and hosting do not change third-party rights; keep [credits and notices](../NOTICE.md) with redistributions.
