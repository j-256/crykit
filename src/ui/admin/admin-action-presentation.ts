import type { AdminCommand } from '../../account/admin-protocol'
import { size } from './admin-view'

const settingNames: Record<string, string> = {
  registrationPaused: 'Registration',
  uploadsPaused: 'Uploads',
  sharingPaused: 'New sharing',
  emailPaused: 'Outbound email',
  maxAccountBytes: 'Maximum account quota',
  projectCapacityBytes: 'Project capacity',
}
const pauseConsequences: Record<string, string> = {
  registrationPaused: 'New account registration stops; existing accounts keep access.',
  uploadsPaused: 'Server uploads stop; local edits remain on devices.',
  sharingPaused: 'New hosted publication stops; existing hosted shares remain readable.',
  emailPaused: 'Queued email waits until resumed. Expired or cancelled mail is not sent; sends in progress cannot be recalled.',
}

export function actionPresentation(command: AdminCommand): { title: string; changes: string[]; consequence: string; danger: boolean } {
  const payload = command.command
  if (payload.type === 'service.settings') {
    const changes = Object.entries(payload.patch).map(([key, value]) =>
      `${settingNames[key] ?? key}: ${typeof value === 'boolean' ? value ? 'Paused' : 'Running' : size(value)}`,
    )
    const entries = Object.entries(payload.patch)
    const consequences = []
    for (const [key, value] of entries) if (key.endsWith('Paused') && value === true) consequences.push(pauseConsequences[key] ?? 'New work of the selected kind stops.')
    if (entries.some(([key, value]) => key.endsWith('Paused') && key !== 'emailPaused' && value === false)) consequences.push('Resuming allows new work of the selected kind, subject to other limits and access rules.')
    if (payload.patch.emailPaused === false) consequences.push('Eligible queued email resumes; expired or cancelled messages are not sent.')
    if (entries.some(([key]) => key.endsWith('Bytes'))) consequences.push('Lower capacity limits preserve data but can block new allocations.')
    return { title: 'Review service settings', changes, consequence: consequences.join(' '), danger: false }
  }
  switch (payload.type) {
    case 'accounts.restrict': return { title: 'Review account access', changes: [`New access: ${payload.policy}`], consequence: payload.policy === 'blocked' ? 'Blocking revokes server access. Cached local copies and downloaded keys remain on devices.' : 'This changes server access for the selected account.', danger: payload.policy === 'blocked' }
    case 'accounts.quota': return { title: 'Review account quota', changes: [`New quota: ${size(payload.quotaBytes)}`], consequence: 'Lower limits preserve data but can block new capacity increases.', danger: false }
    case 'accounts.delete': return { title: 'Review account deletion', changes: ['Delete the selected account'], consequence: 'Deletion removes account data from the service after the guarded workflow completes.', danger: true }
    case 'accounts.sessions.revoke': return { title: 'Review session revocation', changes: [payload.all ? 'Revoke all server sessions' : `Revoke ${payload.sessionIds?.length ?? 0} selected server sessions`, ...(payload.revokePendingApprovals ? ['Revoke pending device approvals'] : [])], consequence: 'Revoked sessions lose server access. Existing local copies remain on devices.', danger: true }
    case 'shares.revoke': return { title: 'Review share revocation', changes: ['Revoke hosted share'], consequence: 'The hosted share stops serving new reads. Previously downloaded copies remain outside this service.', danger: true }
    case 'operators.remove': return { title: 'Review operator removal', changes: ['Remove operator access'], consequence: 'The selected operator loses administrative access.', danger: true }
    case 'operators.invitation.cancel': return { title: 'Review invitation cancellation', changes: ['Cancel operator invitation'], consequence: 'The invitation can no longer be accepted.', danger: true }
    case 'jobs.cancel': return { title: 'Review job cancellation', changes: ['Cancel selected job'], consequence: 'The selected pending job will not be started by this service.', danger: true }
    case 'jobs.retry': return { title: 'Review job retry', changes: ['Retry selected job'], consequence: 'A new attempt may cause an external effect; inspect the recorded outcome first.', danger: false }
    case 'accounts.verification.resend': return { title: 'Review verification resend', changes: ['Send verification mail again'], consequence: 'Provider acceptance does not prove recipient delivery.', danger: false }
    case 'accounts.username.withhold': return { title: 'Review attribution change', changes: ['Withhold public username'], consequence: 'Public attribution is changed for this account.', danger: false }
    case 'operators.invite': return { title: 'Review operator invitation', changes: [`Invite ${payload.email} as administrator`], consequence: 'The invitation alone grants no access; acceptance and Access policy still apply.', danger: false }
  }
}
