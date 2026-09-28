# Public deployment and recovery

The public application is [crycom.lasers.app](https://crycom.lasers.app/). Its source is [j-256/crystal-companion](https://github.com/j-256/crystal-companion). Personal data stays in each browser; deployments contain the static application, public reference catalog, artwork, OCR resources, and license notices.

## Deployment contract

`wrangler.jsonc` owns the assets-only Worker `crystal-companion` and the `crycom.lasers.app` Custom Domain. There is no Worker script, server database, account system, or upload endpoint. Both workers.dev and preview URLs are disabled. The application uses hash routes, so arbitrary missing asset paths should return 404 instead of the application shell. `public/_headers` supplies the content security policy and cache headers.

Use Node.js 24, install with `npm ci`, then run:

```sh
npm run verify
npm run deploy:dry-run
```

Install Chromium with `npx playwright install chromium` before browser verification on a fresh machine. A dry run validates the built `dist/` tree and does not publish it. A deployment uses `npm run deploy`, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` supplied through the environment. Use an account token with Workers Scripts edit and permission to manage the Custom Domain in the intended zone. Keep credentials out of source and browser build variables.

## Public-only GitHub Actions

Keep repository Actions disabled while a repository is private. Prepare and verify changes locally, push them with Actions disabled, make the repository public, and confirm GitHub reports public visibility before enabling Actions or dispatching the workflow. Disable Actions before making a public repository private. Private forks must leave Actions disabled.

The reviewed `.github/workflows/deploy.yml` runs only for public repositories. Pull requests run verification and the deployment dry run. Pushes to `main` and manual runs on `main` also deploy after verification succeeds, using the repository Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Deployment is limited to `j-256/crystal-companion`; change that explicit owner guard when intentionally transferring hosting. Actions are pinned by commit, use a standard Linux runner, and receive read-only repository permissions. Deployment credentials are supplied only to the deployment step. Runs for a ref are serialized to avoid overlapping publication.

GitHub's [Actions billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions) describes free standard hosted-runner use for public repositories. A public repository does not make larger runners or other billed services free.

Verification builds the application once, checks deployment limits, and passes that artifact to desktop and mobile browser shards. Deployment uses the same artifact only after every shard succeeds. Browser assertions keep their normal timeouts; complete journeys have a one-minute budget. Failed browser jobs retain synthetic traces and screenshots for diagnosis, and GitHub annotations expose failures as they occur. Application and failure artifacts expire after one day to bound storage use.

## Hostnames and redirects

Cloudflare manages TLS and DNS for the canonical Custom Domain. The `lasers.app` zone separately owns the aliases:

| Hosts | Behavior | Owner |
| --- | --- | --- |
| `crycom.lasers.app` | Static application | Worker Custom Domain in `wrangler.jsonc` |
| `cp.lasers.app`, `crystal.lasers.app` | HTTP 307 to the canonical host, preserving method, path, and query | Single Redirect rule `crystal_companion_aliases` plus originless proxied DNS |

The redirect rule matches `http.host in {"cp.lasers.app" "crystal.lasers.app"}`, uses target expression `concat("https://crycom.lasers.app", http.request.uri.path)`, status `307`, and `preserve_query_string: true`. Alias DNS is a proxied `AAAA` record with content `100::`, reserved for discard-only use. No application Worker owns the aliases. Do not replace this with a 301 or 302, which can change the request method. A preserved POST reaches a static destination that does not accept writes; the redirect itself does not promise a successful POST response.

The exact-host Configuration Rule `crystal_companion_disable_rum` matches `crycom.lasers.app` and sets `disable_rum: true`, preventing automatic Cloudflare Web Analytics injection. Maintain this independently of Worker deployments so the application's no-telemetry behavior remains true. Use Cloudflare Fleet to inspect and plan changes to the zone rules before applying them.

## Free-plan compatibility

Verified against Cloudflare documentation on 2026-09-28: [static asset requests are free and unlimited](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/). The [Workers Free static asset limits](https://developers.cloudflare.com/workers/platform/limits/#static-assets) are 20,000 files per Worker version and 25 MiB per file. `npm run check:assets` measures every built file, prints the file count, total bytes, and largest file, and rejects either limit exceedance before dry runs and deployments. A representative build is about 35 MiB in total, with its largest file about 11 MiB; the limits apply per file and per version, not to that total byte count. Reproduce the measurements with `npm ci && npm run build && npm run check:assets` after dependency or catalog changes.

The aliases share one [Single Redirect rule](https://developers.cloudflare.com/rules/url-forwarding/single-redirects/), against the Free allowance of 10 per zone. Analytics suppression uses one [Configuration Rule](https://developers.cloudflare.com/rules/configuration-rules/) against that product's Free zone allowance. Other applications share the zone quotas, so inspect usage before adding rules. These requirements fit Free and do not require a Paid Worker. If assets outgrow Free, reduce or split the bundled material before release, or document and review a Paid requirement; successful deployment on a Paid account does not prove Free compatibility.

## Verification and recovery

After deployment, inspect the Worker, serving version, Custom Domain, and disabled workers.dev/preview settings. Check the app in a fresh desktop and mobile browser, open Reference artwork and Credits & licenses, prepare it for offline use, and reload while offline. Confirm the network contains no analytics injection or external game-data requests. Probe both aliases with GET and POST on a path with a query, and verify HTTP 307 plus the exact destination. A browser hash route should survive alias navigation.

For a failed release, rebuild a known-good source revision and deploy its verified `dist/` tree, or use Wrangler's deployment rollback after inspecting the serving versions. Rollback of hosted files does not restore or migrate a user's browser database. App updates wait for explicit activation; cache cleanup retains the active and previous build for the same installation, leaving other installations and IndexedDB alone. Save drafts and reload older tabs after an update. Export personal backups before changing browser origins or clearing site storage.

Cloudflare redirects `index.html` to the directory URL. The service worker copies redirected cached HTML responses before returning them to navigations, which reject a response with a redirect history. The subpath browser fixture reproduces that redirect and verifies updates and offline reloads with saved observations.

Recovery requires the repository, lockfile, Actions configuration and secrets, Cloudflare account access, Custom Domain, alias DNS, redirect rule, and analytics Configuration Rule. These are separate state: restoring only a Git checkout does not restore zone settings or credentials. Source publication and hosting do not change third-party rights; keep [credits and notices](../NOTICE.md) with redistributions.
