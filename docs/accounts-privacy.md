# Privacy, uploads, and recovery

These terms explain CryKit's website performance measurements, optional account service, public sharing, and recovery. For privacy, abuse, or rights complaints, contact [abuse@crykit.lasers.app](mailto:abuse@crykit.lasers.app).

## What leaves your browser

Guest editing works without an account or a working account service. Guest data stays on your device. When you use an account workspace, its private data is encrypted in your browser before upload. This includes original files, saved history, drafts with errors, saves CryKit cannot interpret, and unresolved conflicts. Sync preserves the original bytes, recorded source versions, and unknown values. Device preferences and current selections stay local. CryKit does not execute descriptions, formulas, or code from imported files.

We collect limited technical information to help keep CryKit secure, reliable, and responsive. For accounts, we keep the records needed to sign you in, synchronize changes, track storage use, investigate failures, and protect against abuse. These records include your account identity and contact details, password authentication records, an encrypted copy of your account key, device and session records, identifiers for stored data and versions, sizes, timestamps, and relationships between stored versions. They describe account activity, such as sync timing and storage use, without including your private workspace contents.

The email provider receives the recipient address and the service messages it delivers, including verification links. Private account storage is not publicly accessible. CryKit does not fetch game data from external services while you use it.

When you use **Share build** or **Share team**, the snapshot contains the build or team name, Team member names, saved selections, selected entry names, required mod versions, and calculation inputs. Private mod files, definition bodies, descriptions, and artwork are not included. Missing mod definitions appear as placeholders until the viewer adds the matching mods to their own library; those local files supply the details and any calculations that depend on them. Written notes and, for hosted shares, your screen name are optional additions.

Hosted shares use an unlisted link. Anyone with that link can read and copy the shared snapshot. Once the service confirms that a hosted share has stopped, its link no longer serves that snapshot. Stopping a share cannot erase copies others have already downloaded. Portable share links contain the snapshot in the URL itself; copied portable links cannot be revoked.

## Website performance measurements

Cloudflare Web Analytics, also called real user monitoring (RUM), helps us identify slow pages and improve the site's stability and responsiveness. On monitored pages, your browser sends Cloudflare technical measurements such as page views, loading and interaction timings, and page and referrer information. Measurements can also include identifiers for page elements and resource URLs associated with rendering or interaction problems. Reports include browser, operating system, device type, and country. This can apply to guest visits as well as account use. See Cloudflare's [RUM data description](https://developers.cloudflare.com/speed/observatory/rum-beacon/) and [report dimensions](https://developers.cloudflare.com/web-analytics/data-metrics/dimensions/).

Cloudflare says its RUM script does not read or write cookies or browser storage, and its [data-collection policy](https://developers.cloudflare.com/web-analytics/data-metrics/data-origin-and-collection/) says Web Analytics does not track individual users across its customers' websites. Cloudflare receives your IP address when handling the network request; it says the RUM service discards that address at the nearest data center without storing it in core databases or logs. These statements describe [Cloudflare's RUM service](https://developers.cloudflare.com/speed/observatory/rum-beacon/); hosting and account-security records have their own purposes and retention rules.

Cloudflare's [analytics policy](https://developers.cloudflare.com/web-analytics/faq/#is-the-data-sampled) describes seven days of unsampled measurements followed by sampled longer-term data, with reports available for the previous six months. Those provider-managed records are separate from the application-log retention periods below. Report availability does not establish a deletion deadline for every provider copy.

## Encryption and recovery

Your private workspace is encrypted in your browser before it is stored on our servers. We cannot look up your encryption key or restore access to your encrypted data using your email address alone. Keep your password and private workspace backups safe, and check that you can open your backups. If you lose every way to unlock your account, its encrypted data may become permanently unreadable. Restoring a service backup still requires your encryption key.

While your workspace is unlocked, its security also depends on the CryKit app, your browser, and your device.

## Upload rights and complaints

Use private account sync only for material you have the right to store. Do not upload credentials, other people's private records, or unlawful material. For public shares, review the build or team details and any optional notes or screen name you include, and publish only material you have the right to share. Game and mod creators retain their rights.

Send privacy, abuse, or rights complaints to [abuse@crykit.lasers.app](mailto:abuse@crykit.lasers.app). Describe the issue, include the affected public share link or any service reference shown with the problem, and provide a way to reply. For a rights complaint, include evidence of the relevant rights or consent. Do not send passwords, account keys, or private save contents.

We keep a case reference, review the information you provide, and respond through the contact you provide. We may pause account uploads or stop an affected hosted share; these actions are recorded for review. We assess complaints using your report and available service records; private workspace contents remain encrypted. A complaint does not provide access to encryption keys or private data, or trigger automatic deletion of unrelated records.

## Retention and removal

Our retention policy is seven days for application logs, 30 days for summaries that do not identify users, and 90 days for audit records of account and administrative actions. These periods apply to application records; hosting providers manage their own records under separate retention policies.

Application diagnostic logs use request references, error codes, and timings. They exclude private contents, passwords, keys, and links that grant access or verify an account. Hosting providers may separately process request metadata. Changing logging settings does not remove information already retained.

Temporary upload data becomes eligible for cleanup after 24 hours only when it is no longer needed. Original files, saved checkpoints and history, data still in use, unfinished work, and retained backups prevent cleanup of the data they need. Eligibility does not guarantee immediate erasure. The unused-sync cleanup action removes eligible redundant sync records without removing original files or saved history. A new device may lack the local records needed to find those cleanup candidates. Reaching a storage limit does not cause automatic deletion of protected data to make room.

Our backup policy calls for daily encrypted backups with retention of up to 30 days. Available recovery points depend on storage capacity and successful backup checks. The recovery screen shows the last verified backup and its age, or reports that backups are paused or their status is unknown. A backup does not include changes made after it was captured.

Records of account deletions, stopped hosted shares, and revoked administrator access are kept separately from backups so restoring an old backup cannot restore that access. Some identifiers and records used to enforce deletion, prevent old writes from restoring removed data, and track storage use may remain indefinitely. These records do not contain private file contents.

Removing an account's local data from a device clears its encrypted cache after the removal checks and confirmation. It does not delete the cloud account or downloaded backup files. Deleting the cloud account first revokes access, then begins cleanup of account data. Cleanup can continue after an interruption. Existing service backups follow their retention policy; account deletion does not start a new retention period. Deleting the cloud account does not erase local copies or files downloaded by you or share recipients.
