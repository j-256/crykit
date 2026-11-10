import { resolve } from 'node:path'
import type { Plugin } from 'vite'

const BEACON_URL = 'https://static.cloudflareinsights.com/beacon.min.js'
const SITE_TOKEN_PATTERN = /^[a-f0-9]{32}$/i

export function rumPlugin(): Plugin {
  let appEntry = ''
  let siteToken = ''
  return {
    name: 'crykit-rum',
    apply: 'build',
    configResolved(config) {
      appEntry = resolve(config.root, 'index.html')
      // This is a public site identifier, never an account credential or provider API token
      // Absent opt-in keeps local and fork builds independent of the owner's analytics site
      siteToken = process.env.CRYKIT_RUM_SITE_TOKEN ?? ''
      if (siteToken && !SITE_TOKEN_PATTERN.test(siteToken)) throw new Error('CRYKIT_RUM_SITE_TOKEN must contain exactly 32 hex characters')
    },
    transformIndexHtml: {
      // Emit after Vite processes entry modules but before offline generateBundle hashes HTML
      // Leave collector defaults intact so authenticated same-origin cookies are not forwarded
      order: 'post',
      handler(_html, context) {
        if (!siteToken || resolve(context.filename) !== appEntry) return []
        return [{ tag: 'script', attrs: { type: 'module', src: BEACON_URL, 'data-cf-beacon': JSON.stringify({ token: siteToken, spa: true }) }, injectTo: 'head' }]
      },
    },
  }
}
