# Closed qualification release tooling

`scripts/qualification-release.mjs` validates, packages and releases only the independent qualification Worker. It cannot activate account, signup, email, confirmation, backup capture or maintenance capabilities. Qualification does not establish production readiness. The production release helper keeps its separate fixed destination and is unchanged by this tool.

Run `node scripts/qualification-release.mjs --config /secure/config.json --identity /secure/identity.json` to check inputs. Add `--dry-run` after building assets with `npm run build` to validate and inspect the exact production-entry bundle without provider writes. Add `--deploy` only under explicit qualification release authorization after establishing the isolated resources, disabled ingress/logging and independent Tail attachment. The CLI does not create resources, apply routes or schedules, provision secrets, configure Access or prove canary acceptance. Active account qualification requires a separate admitted effect budget and ingress proof; this closed publisher deliberately rejects that configuration.

Both input files must be absolute owner-owned regular JSON files, inaccessible to group or other users, without final symlinks and outside the source checkout. The identity inventory is version 1 with exactly these fields:

| Field | Meaning |
| --- | --- |
| `version` | Integer `1` |
| `workerName`, `origin` | Exact `crykit-qualification` and `https://qualify.crykit.lasers.app` |
| `databaseId` | Created qualification metadata database UUID |
| `limiterNamespaceIds` | Unique decimal strings ordered network, account, auth, location |
| `adminIssuer` | Exact approved HTTPS Cloudflare Access issuer |
| `adminAudience`, `confirmationAudience` | Distinct qualification audience strings |
| `excludedDatabaseIds` | Nonempty unique baseline database UUID inventory |
| `excludedLimiterNamespaceIds` | Nonempty unique baseline limiter namespace inventory |
| `excludedAccessAudiences` | Nonempty unique baseline Access audience inventory |

Obtain the complete baseline and qualification identities from provider readback before preparing this inventory. The validator rejects overlap and pins configuration to this reviewed input; it cannot establish whether an operator omitted a baseline resource or mislabeled an Access application. The publisher separately verifies the actual database name and UUID and exact bucket names before uploading. Do not copy production or preview storage, secrets, sessions or memberships into qualification.

The Wrangler input selects `worker/index.ts`, the pinned OPAQUE adapter, the qualification Custom Domain, `crykit-qualification-metadata`, and exactly `crykit-qualification-objects`, `crykit-qualification-backups` and `crykit-qualification-revocations`. It requires every original secret name, distinct rate-limit bindings, explicit disabled alternate ingress/logging and `crykit-qualification-alerts`. CPU and application storage cannot exceed the qualification ceilings enforced in the validator. Native email is restricted to the fixed sender and an exact bounded list of authorized `@crykit.lasers.app` test recipients, although sending stays disabled. Secrets are inherited by name; this tool never reads, generates, rotates or proves original secret values.

Each publication checks effective live ingress, producer logging and Tail policy before account code upload, verifies the single uploaded version's runtime and complete binding inventory, then assigns that exact version full traffic. It reads serving authority and effective policy afterward. An interrupted deployment is read back before any retry; an ambiguous or mismatched result fails without automatically publishing a second version. Private subprocess diagnostics stay bounded in an owner-only temporary directory. Preserve their confidentiality and inspect actual provider state before retrying.

The Node recovery reader accepts a separate version-1 envelope `{version:1, environment:"qualification", secrets:{...}}` with the original seven secret values. This is distinct from the multi-environment operational store described in [account deployment](accounts-deployment.md#original-secrets-and-restoration). Qualification must be named explicitly in both the file and reader call. Existing local, preview and production envelopes retain their meaning. The reader preserves ownership, mode, no-follow and byte-limit checks; it does not create or migrate protected files.

Focused verification is `node --test scripts/qualification-release.test.mjs scripts/production-release.test.mjs` and `npx vitest run --project worker worker/operations/recovery-secret-source.test.ts`. These contracts establish tooling boundaries, not deployed Access enforcement, original-key custody or hosted workload capacity.
