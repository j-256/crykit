import { createHash } from 'node:crypto'
import type { Page } from './test-fixture'

// Observe the actual frozen mapping-worker schema exception without changing its executable or reply
export async function observeMappingQualificationExceptions(page: Page, fingerprintErrors = false) {
  const cdp = await page.context().newCDPSession(page)
  let sequence = 0
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  const failures: string[] = [], sessions = new Set<string>()
  const schemaFailures: { name: string; issues: { path: unknown; code: string }[]; worker: string }[] = []
  const exceptionFailures: { name: string; fingerprint: string; location: { url: string; line: number; column: number } }[] = []
  const workers = new Map<string, string>()
  const send = (sessionId: string, method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => { pending.delete(id); reject(error) })
  })
  cdp.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message)
    if (message.id) {
      const request = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) request?.reject(new Error(message.error.message)); else request?.resolve(message.result)
      return
    }
    if (message.method !== 'Debugger.paused') return
    void (async () => {
      const paused = message.params
      try {
        if (paused.data?.objectId) {
          if (fingerprintErrors) {
            const actual = await send(event.sessionId, 'Runtime.callFunctionOn', { objectId: paused.data.objectId, functionDeclaration: 'function() { return { name: typeof this.name === "string" ? this.name : "unknown", message: typeof this.message === "string" ? this.message : "unknown" } }', returnByValue: true })
            if (actual.result?.value && exceptionFailures.length < 32) {
              // Plain error text exists only long enough to hash; attachments never retain it or frame locals
              const { name, message } = actual.result.value, location = paused.callFrames[0]
              exceptionFailures.push({ name, fingerprint: createHash('sha256').update(message).digest('hex'), location: { url: location.url, line: location.location.lineNumber, column: location.location.columnNumber } })
            }
          }
          const error = await send(event.sessionId, 'Runtime.callFunctionOn', { objectId: paused.data.objectId, functionDeclaration: 'function() { return this.name === "ZodError" ? { name: this.name, issues: this.issues.slice(0, 8).map(issue => ({ path: issue.path, code: issue.code })) } : null }', returnByValue: true })
          if (error.result?.value) {
            if (schemaFailures.length >= 32) throw new Error('Qualification schema exception evidence exceeded its bound')
            schemaFailures.push({ ...error.result.value, worker: workers.get(event.sessionId) ?? 'unavailable' })
          }
        }
      } catch (error) { failures.push(String(error)) }
      finally { await send(event.sessionId, 'Debugger.resume') }
    })().catch(error => failures.push(String(error)))
  })
  cdp.on('Target.detachedFromTarget', event => { sessions.delete(event.sessionId) })
  cdp.on('Target.attachedToTarget', event => {
    sessions.add(event.sessionId)
    workers.set(event.sessionId, event.targetInfo.url)
    void (async () => {
      const relevant = event.targetInfo.url.includes('account-local-mapping-worker-')
      if (relevant) {
        await send(event.sessionId, 'Debugger.enable')
        await send(event.sessionId, 'Debugger.setPauseOnExceptions', { state: 'all' })
      }
      await send(event.sessionId, 'Runtime.runIfWaitingForDebugger')
    })().catch(error => failures.push(String(error)))
  })
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false })
  return { schemaFailures, exceptionFailures, failures, async stop() {
    for (const sessionId of sessions) { try { await send(sessionId, 'Debugger.setPauseOnExceptions', { state: 'none' }) } catch { /* A normally retired worker has no remaining debug session */ } }
    await cdp.detach()
  } }
}
