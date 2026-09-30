# Crystal Companion development

Build a local-first planner with explicit unknown values. Keep catalog definitions, personal observations, and planned configurations separate. Never execute imported descriptions or formulas, infer current inventory from historical acquisition, or derive character learning from party-wide progress.

Preserve backward compatibility for persisted user data across application versions so upgrades do not lose or silently reinterpret it. Version persisted formats explicitly, migrate older data transactionally, preserve unknown values and provenance, and verify rollback on failure. Internal APIs and synthetic fixtures may change without compatibility shims when they do not affect persisted user data.

Do not commit personal imports, source workbooks, playthrough trackers, backups, screenshots with personal records, local paths, or credentials. Use synthetic fixtures. Fresh browser environments start with labeled synthetic sample records; explicitly created Playthroughs start blank. The application makes no runtime requests for game data.

GitHub Actions must remain disabled while the repository is private. Verify public visibility through GitHub before enabling Actions. The reviewed public deployment workflow runs local-equivalent checks and deploys only main; every job must retain its public-repository guard. Do not enable hosted runners for a private fork.

Use strict TypeScript and pure domain functions for validation. Keep React out of the domain layer. Verify save failures, import rollback, unknown quantities, simultaneous stock conflicts, backup round-trips, and offline behavior.

Use the shared `useQueuedTileUpdates` hook for immediate-save tile boards. Follow [the queued tile update pattern](docs/queued-tile-updates.md): hold the latest requested state until its queue drains, keep tile clicks enabled, suppress transient saving labels, and verify stable surrounding tiles and controls.

Use Conventional Commits, explicit staging paths, and inspect staged content before committing. Keep the canonical checkout on main and implementation in disposable worktrees. Do not rewrite another contributor's changes.

Use straight quotes and avoid em dashes. Write paragraphs on one source line. Code comments use ASCII and no terminal period.
