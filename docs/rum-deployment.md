# Cloudflare performance monitoring

Cloudflare Web Analytics, also called real user monitoring (RUM), is planned for CryKit to diagnose performance and stability problems. The [privacy terms](accounts-privacy.md#website-performance-measurements) describe its browser measurements and provider-managed records. RUM activation is separate from account activation, application diagnostics and producer logging.

## Disabled baseline and activation scope

On 2026-11-10, Cloudflare Fleet readback confirmed enabled Configuration Rules `crykit_disable_rum` for `crykit.lasers.app` and `crykit_preview_disable_rum` for `preview.crykit.lasers.app`, both setting `disable_rum: true`. The application CSP also excludes the external beacon script. Keep these protections until the selected host's collection boundaries pass the checks below. A successful Worker deployment or updated terms do not enable RUM.

Use Fleet to review the exact host, rule, exclusions and rollback before changing provider state. Inspect the Web Analytics site's injection and regional settings as well: removing a blocking rule does not establish which pages or visitors are measured. Preserve unrelated host rules and customer-account gates. Configuration Rules take precedence over [Web Analytics rules](https://developers.cloudflare.com/web-analytics/configuration-options/rules/).

## Collection boundaries

Cloudflare documents page and referrer information, performance timings and [report dimensions](https://developers.cloudflare.com/web-analytics/data-metrics/dimensions/). Its [FAQ](https://developers.cloudflare.com/web-analytics/faq/) says query strings are not logged, but that statement alone does not establish what every outbound field contains. The beacon is third-party code running in the page; not reading browser storage does not prevent it from observing rendered elements or resource URLs.

A synthetic, intercepted Chromium check on 2026-11-10 found that the downloaded beacon stripped query strings and fragments from top-level page/referrer fields, but sent DOM identifiers in interaction attribution and unsanitized image URLs in rendering attribution. A fixture matching a scenario card exposed a marker representing a private record from its ancestor element ID. Disabling SPA measurement did not remove those fields. These observations apply to the tested artifact and cases; they do not establish a permanent provider contract or complete browser coverage.

Before enablement:

- Prevent private record identifiers, imported content, passwords, keys, verification capabilities and portable-share payloads from reaching beacon bodies or request headers. Check page/referrer fields, image URLs and element attribution independently; changing only page URL handling is insufficient.
- Capture synthetic measurements for initial navigation, hash routes, history navigation, interactions and page exit. Include guest/account views, sharing, verification and administration. Verify exclusions for any surface whose collection cannot be bounded, including navigation into it after the beacon has loaded.
- Preserve the existing `Referrer-Policy: no-referrer` protection and permit only the exact required beacon script and collector in CSP. Do not widen script or connection policy to arbitrary external origins. Verify the effective headers on each selected page.
- Publish matching privacy copy, inspect actual injection and payloads, and verify that blocked or unavailable analytics do not break guest editing, account workflows or offline use. Keep producer logs, traces and private Tail forwarding under their existing restrictions.
- Record the exact host, serving artifact, beacon artifact, regional scope, payload evidence and reversible provider change. Recheck after relevant application or beacon changes. Restore `disable_rum: true` and the restrictive script policy if the verified collection boundary fails.

## Provider limits and retention

Web Analytics is available without a paid plan, but its own host/path [rules](https://developers.cloudflare.com/web-analytics/limits/) have no Free allowance. Configuration Rules are a separate product with separate quotas. Verify the chosen exclusion mechanism against the zone's actual entitlement; do not assume Workers Paid supplies it. These product distinctions were checked against the linked documentation on 2026-11-10.

Cloudflare's [FAQ](https://developers.cloudflare.com/web-analytics/faq/#is-the-data-sampled) describes unsampled measurements for seven days, sampled longer-term data and reports for the previous six months. The application's seven-day log, 30-day summary and 90-day audit policies do not control Cloudflare's RUM dataset. Report availability is not proof that every provider copy has been deleted. Retain the provider's stated limits in the privacy disclosure without claiming a stronger deletion guarantee.
