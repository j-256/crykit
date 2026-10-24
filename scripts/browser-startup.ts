// This classic script must run before the entry graph can fail, including while offline
// An import inside the graph cannot report a dependency that prevented its own execution
// Keep JavaScript syntax for direct classic-script emission; contextual DOM callbacks retain strict type checking
(() => {
  const retryKey = 'crykit-entry-retry:' + location.pathname
  const navigationId = crypto.randomUUID()
  const entrySelector = 'script[type="module"][src]'
  const handlers = new AbortController()
  const listenerOptions = { capture: true, signal: handlers.signal }
  const showRecovery = () => {
    const root = document.getElementById('root')
    if (!root) return
    const main = document.createElement('main')
    main.className = 'loading-screen'
    const content = document.createElement('div')
    content.className = 'loading-screen__content'
    const heading = document.createElement('h1')
    heading.textContent = 'Application files could not be opened'
    const message = document.createElement('p')
    message.setAttribute('role', 'alert')
    message.textContent = 'Your saved data has been kept. Reload CryKit to try again.'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = 'Reload CryKit'
    retry.addEventListener('click', () => {
      try { sessionStorage.removeItem(retryKey) } catch { /* Explicit recovery works without storage */ }
      location.reload()
    })
    content.append(heading, message, retry)
    main.append(content)
    root.replaceChildren(main)
  }
  document.addEventListener('error', event => {
    if (!(event.target instanceof HTMLScriptElement) || !event.target.matches(entrySelector)) return
    handlers.abort()
    // Retry only before entry execution, never after an editing view has opened
    // Without durable per-tab bookkeeping, require an explicit action instead of risking a reload loop
    let attempted = true
    try {
      attempted = sessionStorage.getItem(retryKey) === '1'
      sessionStorage.setItem(retryKey, '1')
    } catch { /* Fail closed to manual recovery */ }
    console.error('crykit_startup_failure', { code: 'ENTRY_MODULE_LOAD_FAILED', navigationId, elapsedMs: Math.round(performance.now()), recovery: attempted ? 'manual' : 'reload' })
    if (attempted) {
      if (document.readyState === 'loading') addEventListener('DOMContentLoaded', showRecovery, { once: true })
      else showRecovery()
      return
    }
    // Complete the failed navigation before reopening so callers can observe its load event
    const reopen = () => setTimeout(() => location.reload(), 0)
    if (document.readyState === 'complete') reopen()
    else addEventListener('load', reopen, { once: true })
  }, listenerOptions)
  // Script load events traverse Document but exclude Window, even during capture
  // Listening on Window would leave recovery armed after the editor opens
  document.addEventListener('load', event => {
    if (!(event.target instanceof HTMLScriptElement) || !event.target.matches(entrySelector)) return
    // Once an entry has executed, later module failures must not reload an editing session
    handlers.abort()
    try { sessionStorage.removeItem(retryKey) } catch { /* Storage denial must not stop startup */ }
  }, listenerOptions)
})()
