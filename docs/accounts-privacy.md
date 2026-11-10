# Account privacy, uploads and recovery

These draft terms describe the optional account service. The owner must approve them and the complaint contact before opening account uploads to the public. Contact [abuse@crykit.lasers.app](mailto:abuse@crykit.lasers.app) for privacy, abuse or rights complaints.

## What leaves your browser

Guest editing works without an account or a working account service. Guest data stays on your device. When you use an account workspace, its private data is encrypted in your browser before upload. This includes original files, saved history, drafts with errors, saves CryKit cannot interpret and unresolved conflicts. Sync preserves the original bytes, recorded source versions and unknown values. Device preferences and current selections stay local. CryKit does not execute descriptions, formulas or code from imported files.

We collect limited technical information to help keep CryKit secure, reliable and responsive. For accounts, we keep the records needed to sign you in, synchronize changes, track storage use, investigate failures and protect against abuse. These records include your account identity and contact details, password authentication records, an encrypted copy of your account key, device and session records, identifiers for stored data and versions, sizes, timestamps and relationships between stored versions. They can reveal usage patterns even though the service cannot read the private contents.

The email provider receives the recipient address and the service messages it delivers, including verification links. Private account storage is not publicly accessible. CryKit does not fetch game data from external services while you use it.

Publishing a hosted share makes the selected build or team snapshot available through an unlisted link. Anyone with that link can read and copy it. Written notes and your screen name are optional additions. Once the service confirms that a hosted share has stopped, its link no longer serves that snapshot. Stopping a share cannot erase copies others have already downloaded. Portable share links contain the snapshot in the URL itself; copied portable links cannot be revoked. See [share behavior](share-links.md) and [deletion](account-deletion.md).

## Website performance measurements

We plan to use Cloudflare Web Analytics, also called real user monitoring (RUM), to help identify slow pages and improve the site's stability and responsiveness. On pages where it is enabled, your browser sends Cloudflare technical measurements such as page views, loading and interaction timings, and page and referrer information. Measurements can also include identifiers for page elements and resource URLs associated with rendering or interaction problems. Reports include browser, operating system, device type and country. This can apply to guest visits as well as account use. See Cloudflare's [RUM data description](https://developers.cloudflare.com/speed/observatory/rum-beacon/) and [report dimensions](https://developers.cloudflare.com/web-analytics/data-metrics/dimensions/).

Cloudflare says its RUM script does not read or write cookies or browser storage, and its [data-collection policy](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/) says Web Analytics does not track individual users across its customers' websites. Cloudflare receives your IP address when handling the network request; it says the RUM service discards that address at the nearest data center without storing it in core databases or logs. These statements describe [Cloudflare's RUM service](https://developers.cloudflare.com/speed/observatory/rum-beacon/); hosting and account-security records have their own purposes and retention rules.

Cloudflare's [analytics policy](https://developers.cloudflare.com/web-analytics/faq/#is-the-data-sampled) describes seven days of unsampled measurements followed by sampled longer-term data, with reports available for the previous six months. Those provider-managed records are separate from the application-log retention periods below. Report availability does not establish a deletion deadline for every provider copy.

## Encryption boundaries

The server stores your private workspace in encrypted form. We cannot recover your encryption key for you. Access to your email account alone cannot restore access to your encrypted data. Losing your password and all other ways to unlock the account can make that data permanently unreadable. Keep your own private workspace backups and check that you can open them. Service backups also contain encrypted data; restoring one does not remove the need for your encryption key.

Encryption also depends on the CryKit code your browser runs, your browser extensions and your device. Malicious code or a compromised device can read data while it is unlocked. Because the operator controls the code delivered to your browser, encryption alone does not prevent the operator from gaining access by changing that code.

## Upload rights and complaints

Upload or publish only material you have the right to use in the chosen way. Private account sync and public sharing are different uses; permission for one does not establish permission for the other. Do not upload credentials, other people's private records or unlawful material. Publishing a share requires reviewing exactly what it exposes, including source attribution and any rights restrictions. Game and mod creators retain their rights.

Send privacy, abuse or rights complaints to [abuse@crykit.lasers.app](mailto:abuse@crykit.lasers.app). Describe the issue, include the affected public share link or any service reference shown with the problem, and provide a way to reply. For a rights complaint, include evidence of the relevant rights or consent. Do not send passwords, account keys or private save contents.

The operator keeps a case reference, reviews the evidence and responds through the contact you provide. The operator may pause uploads to the account service or stop an affected hosted share; these actions are recorded for review. Encryption does not establish that uploaded material is permitted, and the operator cannot inspect encrypted private contents to decide a complaint. A complaint does not provide access to encryption keys or private data, or trigger automatic deletion of unrelated records. The operator must review applicable legal requirements and complaint procedures before opening public uploads.

## Retention and removal

The planned retention periods are seven days for application logs, 30 days for summaries that do not identify users and 90 days for audit records of account and administrative actions. The operator must configure and verify these periods with the hosting provider before activation.

Diagnostic logs must exclude private contents, passwords, keys and links that grant access or verify an account. They use request references, error codes and timings to investigate failures. The operator must also verify what the hosting provider records; changing logging settings does not remove information already retained. The required controls are described in [deployment logging](accounts-deployment.md#environment-configuration).

Temporary upload data becomes eligible for cleanup after 24 hours only when it is no longer needed. Original files, saved checkpoints and history, data still in use, unfinished work and retained backups prevent cleanup of the data they need. Eligibility does not guarantee immediate erasure. The unused-sync cleanup action removes eligible redundant sync records without removing original files or saved history. A new device may lack the local records needed to find those cleanup candidates. Reaching a storage limit does not cause automatic deletion of protected data to make room.

The service aims to create encrypted backups daily and retain them for up to 30 days, subject to available storage and successful backup checks. These are targets, not guaranteed recovery coverage. The recovery screen shows the last verified backup and its age, or reports that backups are paused or their status is unknown. A backup does not include changes made after it was captured.

Records of account deletions, stopped hosted shares and revoked administrator access are kept separately from backups so restoring an old backup cannot restore that access. Some identifiers and records used to enforce deletion, prevent old writes from restoring removed data and track storage use may remain indefinitely. These records do not contain private file contents.

Removing an account's local data from a device clears its encrypted cache after the removal checks and confirmation. It does not delete the cloud account or downloaded backup files. Deleting the cloud account first revokes access, then begins cleanup of account data. Cleanup can continue after an interruption. Existing service backups follow their retention policy; account deletion does not start a new retention period. Deleting the cloud account does not erase local copies or files downloaded by you or share recipients. See [account deletion](account-deletion.md), [storage accounting](account-sync-storage.md#customer-storage-and-recovery) and [service recovery](accounts-recovery.md).
