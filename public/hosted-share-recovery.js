// An older offline shell resolves its startup script under the new public pathname
// Run before its module graph without touching saved data or forcing an app update
(() => {
  const script = document.currentScript
  const sharePath = /^\/[bts]\/(?:[A-Za-z0-9_-]{11}|[A-Za-z0-9_-]{21}[AQgw])$/
  if (!(script instanceof HTMLScriptElement) || !/^\/[bts]\/assets\/startup-recovery-[a-f0-9]{16}\.js$/.test(new URL(script.src).pathname) || !sharePath.test(location.pathname)) return
  // The old shell may contain a later analytics module; its clean locator must not enter that collector
  const policy = document.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:"
  document.head.append(policy)
  const root = document.getElementById('root')
  if (!root) return
  const main = document.createElement('main')
  main.className = 'loading-screen'
  const content = document.createElement('div')
  content.className = 'loading-screen__content'
  const heading = document.createElement('h1')
  heading.textContent = 'Update CryKit to open this share'
  const message = document.createElement('p')
  message.setAttribute('role', 'alert')
  message.textContent = 'This browser has an older offline app. Open CryKit home and choose Refresh app in Storage. Then reopen this share link from your message or browser history. Your saved data has not been changed.'
  const home = document.createElement('a')
  home.href = '/#/settings/storage'
  home.textContent = 'Open CryKit home'
  home.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:8px 16px;border:1px solid currentColor;border-radius:4px;color:inherit;text-decoration:underline'
  content.append(heading, message, home)
  main.append(content)
  root.replaceChildren(main)
})()
