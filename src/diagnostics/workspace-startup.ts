export const WORKSPACE_STARTUP_MARK = 'crykit-workspace-startup'
export const WORKSPACE_STARTUP_PHASE = Object.freeze({
  begin: 'begin', selection: 'selection', profiles: 'profiles', unlocked: 'unlocked',
  sodiumImported: 'sodium-imported', sodiumReady: 'sodium-ready',
  managed: 'managed-repository', root: 'admitted-root', evidence: 'admitted-evidence',
  guest: 'guest-preparation', guestPrepared: 'guest-prepared', guestMonitor: 'guest-retained-comparison', guestCompared: 'guest-retained-compared',
  repository: 'repository', failed: 'failed',
} as const)
type StartupPhase = typeof WORKSPACE_STARTUP_PHASE[keyof typeof WORKSPACE_STARTUP_PHASE]

export function recordWorkspaceStartup(phase: StartupPhase): void {
  const timeline = performance as typeof performance & {
    mark?: (name: string, options: { detail: { phase: StartupPhase } }) => unknown
    clearMarks?: (name: string) => void
  }
  if (!timeline.mark || !timeline.clearMarks) return
  // Keep one local status without retaining identities or accumulating marks across repeated reopenings
  // Performance observers still receive every phase as it happens, including before a stalled await
  timeline.clearMarks(WORKSPACE_STARTUP_MARK)
  timeline.mark(WORKSPACE_STARTUP_MARK, { detail: { phase } })
}
