# Account privacy, uploads and recovery

These terms describe the optional account service and are prepared for owner review before general public uploads. Contact [abuse@crykit.lasers.app](mailto:abuse@crykit.lasers.app) for privacy, abuse or rights complaints.

## What leaves your browser

Guest editing works without an account or a working account service. Guest databases remain on the device. When you deliberately use an account workspace, private account payloads are encrypted in your browser before account storage or upload. This includes retained originals and history, invalid drafts, unsupported saves and unresolved conflicts. Exact bytes, source identity, unknown values and historical pins remain meaningful; sync does not reinterpret them. Device preferences and current selections stay local. Imported descriptions, formulas and code are data and are never executed.

The service stores encrypted private payloads and the metadata needed to authenticate accounts, account for storage and synchronize them. That metadata includes account/contact identity, password-protocol records and encrypted key envelopes, device/session records, opaque object/revision IDs, sizes, timing, dependencies, counters and security/audit records. It can reveal usage patterns even without plaintext. The email provider processes the recipient and authored transactional message, including verification capabilities. The service uses no public R2 bucket, image proxy, analytics or runtime game-data requests.

A public share is a separate deliberate publication of the reviewed public snapshot. It is not private encrypted account storage. Anyone with access to a live share can read and copy it. Stopping a share prevents future service access after acknowledged revocation; it cannot erase copies already downloaded by others. See [share behavior](share-links.md) and [deletion](account-deletion.md).

## Encryption boundaries

The server never decrypts a private workspace and email cannot recover its encryption key. Losing the password and all usable recovery material can make encrypted content permanently unreadable. Keep independent private workspace backups and verify that you can open them. A server snapshot preserves encrypted service state, not a plaintext recovery service.

Browser encryption depends on the code delivered by the application origin, the browser and device. Compromised delivered code, extensions or a compromised device can read content while it is unlocked. Encryption does not prove that the operator can never gain access through changed client code, and it does not grant copyright immunity or permission to upload someone else's work.

## Upload rights and complaints

Upload or publish only material you have the right to use in the chosen way. Private account sync and public sharing are different uses; permission for one does not establish permission for the other. Do not upload credentials, other people's private records or unlawful material. Publishing a share requires reviewing exactly what it exposes, including source attribution and any rights restrictions. Game and mod creators retain their rights.

Send privacy, abuse or rights complaints to [abuse@crykit.lasers.app](mailto:abuse@crykit.lasers.app). Include the affected public URL or opaque service identifier, the issue, evidence of the relevant rights or consent, and a way to reply. Do not send passwords, account keys or private save contents. The operator records a minimal case reference, reviews the evidence, may pause uploads or stop an affected public share through audited controls, and communicates the result through that contact. Private ciphertext is not evidence of lawful content and the operator cannot inspect its plaintext. A complaint does not authorize key recovery, arbitrary private-data disclosure or automatic deletion of unrelated records. Legal process and jurisdiction-specific handling require the operator's review before public activation.

## Retention and removal

The operational retention policy is seven days for application logs, 30 days for non-identifying aggregate summaries and 90 days for audit events. Provider logging/exports must be configured and verified separately; these are not proven live retention settings merely because the code emits safe fields. Logs exclude private content, passwords, keys and capability URLs. Disable request-enriched producer log persistence and retain only validated diagnostic samples through the private Tail consumer, as described in [deployment logging](accounts-deployment.md#environment-configuration). Disabling automatic invocation logs alone does not redact provider metadata on custom logs. Opaque correlation/job IDs, bounded authored error codes and timings support diagnosis. Configuration changes do not retroactively redact records already retained by the provider.

Unretained upload staging becomes eligible for cleanup after 24 hours. This is not a guaranteed physical erasure deadline. Protected originals, checkpoints, histories, current references, unfinished work and retained snapshots block cleanup. Explicit unused-sync cleanup removes only eligible obsolete transport envelopes and does not reclaim original/history bodies. Local discovery may be unavailable on a fresh device. No silent eviction occurs at capacity.

Daily service snapshots and retention up to 30 days are operational targets conditional on measured capture admission, storage and verification. The recovery screen reports the actual verified point and age or an honest paused/unknown state. A verified snapshot does not cover later edits. Independent account deletion, stopped-share and operator-revocation records survive snapshot expiry to prevent an old restore from reopening removed authority. Permanent content-free object markers and minimal opaque accounting/control records can remain indefinitely.

Device-local removal clears the reviewed encrypted account cache only after the guarded removal flow; the cloud account and downloaded backup files are separate. Account deletion first ends authority, then uses independently acknowledged revocation and resumable cleanup. Retained recovery copies follow their documented policy without renewed retention for the deleted account. Copies exported by you or other share recipients are outside service deletion. See [account deletion](account-deletion.md), [storage accounting](account-sync-storage.md#customer-storage-and-recovery) and [service recovery](accounts-recovery.md) for the exact boundaries.
