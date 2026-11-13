import { LAUNCH_DATA_GENERATION } from '../domain/data-generation'

export const GUEST_PLANNER_DATABASE = `crykit-${LAUNCH_DATA_GENERATION}`
export const GUEST_COORDINATOR_DATABASE = `${GUEST_PLANNER_DATABASE}-coordinator`
const PRELAUNCH_DATABASES = new Set(['crykit', 'crykit-guest-coordinator-v1', 'crykit-mod-inspector-v1', 'crykit-workspace-files-v1'])

export function isPrelaunchGuestDatabase(name: string): boolean {
  return PRELAUNCH_DATABASES.has(name) || name.startsWith('crykit-restored-v2-') || name.startsWith('crykit-profile-') || name.startsWith('crykit-recovery-')
}
