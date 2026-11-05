import { test, type ConsoleMessage } from '@playwright/test'
import { writeFile } from 'node:fs/promises'

const OFFLINE_OBSERVATION_PREFIX = 'crykit-offline-observation:'

export const observedOfflineTest = test.extend({
  page: async ({ page }, use, info) => {
    const events: unknown[] = []
    const collect = (message: ConsoleMessage) => {
      const text = message.text()
      if (!text.startsWith(OFFLINE_OBSERVATION_PREFIX)) return
      try { events.push({ receivedAtUnixMs: Date.now(), event: JSON.parse(text.slice(OFFLINE_OBSERVATION_PREFIX.length)) }) } catch { /* Diagnostics must not replace the journey's failure */ }
    }
    // Keep received observations in the test process so an unresponsive page cannot erase its last progress
    // Page delivery times and long tasks do not measure worker CPU or disk latency
    page.on('console', collect)
    await page.addInitScript(prefix => {
      const record = (type: string, data: Record<string, unknown> = {}) => console.debug(prefix + JSON.stringify({ type, now: performance.now(), timeOrigin: performance.timeOrigin, visibility: document.visibilityState, ...data }))
      record('start', { controlled: !!navigator.serviceWorker.controller })
      navigator.serviceWorker.addEventListener('controllerchange', () => record('controller-change'))
      void navigator.serviceWorker.ready.then(() => record('worker-ready'))
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data?.type !== 'OFFLINE_PROGRESS') return
        const progress = event.data.progress
        if (!progress) return
        // Whitelist aggregate app-file counters; never capture arbitrary worker messages or user content
        record('progress', Object.fromEntries(['completedFiles', 'totalFiles', 'completedBytes', 'totalBytes'].filter(key => typeof progress[key] === 'number').map(key => [key, progress[key]])))
      })
      const longTasksSupported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
      record('long-task-support', { supported: longTasksSupported })
      if (longTasksSupported) new PerformanceObserver(list => {
        for (const entry of list.getEntries()) record('long-task', { startedAt: entry.startTime, duration: entry.duration })
      }).observe({ type: 'longtask' })
    }, OFFLINE_OBSERVATION_PREFIX)
    try { await use(page) }
    finally {
      page.off('console', collect)
      const path = info.outputPath('offline-preparation-observation.json')
      await writeFile(path, JSON.stringify({ qualification: 'Passive page delivery observations; worker, network and disk costs are not attributed', events }))
      await info.attach('offline-preparation-observation', { contentType: 'application/json', path })
    }
  },
})
