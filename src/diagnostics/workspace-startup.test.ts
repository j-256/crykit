import { PerformanceObserver, type PerformanceMark } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import { recordWorkspaceStartup, WORKSPACE_STARTUP_MARK, WORKSPACE_STARTUP_PHASE } from './workspace-startup'

afterEach(() => { vi.unstubAllGlobals(); performance.clearMarks(WORKSPACE_STARTUP_MARK) })

it('streams every startup phase while retaining only the latest phase in a long-lived document', async () => {
  const observed: unknown[] = []
  await new Promise<void>(resolve => {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (entry.name === WORKSPACE_STARTUP_MARK) observed.push((entry as PerformanceMark).detail)
      if (observed.length === 2) { observer.disconnect(); resolve() }
    })
    observer.observe({ type: 'mark' })
    recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.begin)
    recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.repository)
  })
  expect(observed).toEqual([{ phase: 'begin' }, { phase: 'repository' }])
  expect(performance.getEntriesByName(WORKSPACE_STARTUP_MARK).map(entry => (entry as PerformanceMark).detail)).toEqual([{ phase: 'repository' }])
})

it('leaves startup available when the runtime provides a clock without User Timing', () => {
  vi.stubGlobal('performance', { now: () => 0 })
  expect(() => recordWorkspaceStartup(WORKSPACE_STARTUP_PHASE.begin)).not.toThrow()
})
