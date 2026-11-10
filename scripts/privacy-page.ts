import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Marked } from 'marked'
import type { Plugin } from 'vite'

const DOCS_URL = 'https://github.com/j-256/crykit/blob/main/docs/'
const PAGE_ASSET = 'privacy/index.html'
const STATIC_ASSETS = [
  { name: 'privacy.css', source: new URL('./privacy-page.css', import.meta.url), type: 'text/css; charset=utf-8' },
  { name: 'crystal-icon.svg', source: new URL('../public/icon.svg', import.meta.url), type: 'image/svg+xml' },
  { name: 'crystal-cricket.svg', source: new URL('../src/assets/crystal-cricket.svg', import.meta.url), type: 'image/svg+xml' },
  { name: 'pixel-operator.woff2', source: new URL('../src/assets/fonts/pixel-operator.woff2', import.meta.url), type: 'font/woff2' },
  { name: 'pixel-operator-CC0.txt', source: new URL('../public/pixel-operator-CC0.txt', import.meta.url), type: 'text/plain; charset=utf-8' },
] as const
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

function policyLink(href: string): string {
  // Validate literal schemes before HTML escaping so entity-obfuscated schemes cannot execute
  // Relative Markdown links may leave this page only for the repository's owning docs directory
  if (!/[\u0000-\u0020\u007f\\]/.test(href)) {
    if (/^#[a-z0-9][a-z0-9_-]*$/i.test(href)) return href
    if (/^(https:|mailto:)/i.test(href)) {
      const url = new URL(href)
      if (url.protocol === 'https:' && !url.username && !url.password || url.protocol === 'mailto:') return url.href
    }
    if (/^(?:\.\/)?[a-z0-9][a-z0-9._/-]*\.md(?:#[a-z0-9_-]+)?$/i.test(href)) {
      const url = new URL(href, DOCS_URL)
      if (url.href.startsWith(DOCS_URL)) return url.href
    }
  }
  throw new Error('Privacy page contains an unsafe or unsupported link')
}

function policyHtml(source: string, home: string): string {
  const headings: { depth: number; id: string; label: string }[] = []
  const used = new Set<string>(['content'])
  const markdown = new Marked({
    async: false,
    walkTokens(token) {
      // This renderer accepts repository Markdown, never imported or account-provided content
      // Reject executable HTML and resource embeds rather than silently publishing a partial policy
      if (token.type === 'html') throw new Error('Privacy page does not allow raw HTML')
      if (token.type === 'image') throw new Error('Privacy page does not allow image embeds')
    },
    renderer: {
      heading({ tokens, depth }) {
        const label = this.parser.parseInline(tokens, this.parser.textRenderer)
        const stem = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section'
        let id = stem
        for (let suffix = 2; used.has(id); suffix++) id = `${stem}-${suffix}`
        used.add(id)
        headings.push({ depth, id, label })
        return `<h${depth} id="${id}" tabindex="-1">${this.parser.parseInline(tokens)}</h${depth}>\n`
      },
      link({ href, title, tokens }) {
        return `<a href="${escape(policyLink(href))}"${title ? ` title="${escape(title)}"` : ''}>${this.parser.parseInline(tokens)}</a>`
      },
    },
  })
  const body = markdown.parse(source) as string
  const titles = headings.filter(heading => heading.depth === 1)
  if (titles.length !== 1) throw new Error('Privacy page requires exactly one top-level heading')
  const toc = headings.filter(heading => heading.depth === 2)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'">
<meta name="description" content="CryKit account privacy, uploads, sharing, retention, and recovery terms">
<title>${escape(titles[0].label)} | CryKit</title>
<link rel="icon" type="image/svg+xml" href="./crystal-icon.svg">
<link rel="stylesheet" href="./privacy.css">
</head>
<body>
<a class="skip-link" href="#content">Skip to terms</a>
<header class="privacy-header">
<a class="brand" href="${escape(home)}" aria-label="CryKit home"><span class="brand__mark"><img alt="" src="./crystal-icon.svg" width="44" height="44"></span><span><strong class="brand__name"><span>Crystal </span><span class="brand__kit"><span>Kit</span><img alt="" class="brand__cricket" src="./crystal-cricket.svg" width="48" height="24"></span></strong><span class="brand__tagline">A Crystal Project planner</span></span></a>
<a class="privacy-return" href="${escape(home)}">Return to CryKit</a>
</header>
<main id="content" tabindex="-1">
${toc.length ? `<nav class="privacy-toc" aria-label="On this page"><h2>On this page</h2><ul>${toc.map(heading => `<li><a href="#${heading.id}">${escape(heading.label)}</a></li>`).join('')}</ul></nav>` : ''}
<article>${body}</article>
</main>
<footer><a href="${escape(home)}">Return to CryKit</a></footer>
</body>
</html>
`
}

export function privacyPagePlugin(): Plugin {
  let sourcePath = ''
  let home = '../'
  let routeBase = '/'
  const render = () => policyHtml(readFileSync(sourcePath, 'utf8'), home)
  return {
    name: 'crykit-privacy-page',
    configResolved(config) {
      sourcePath = resolve(config.root, 'docs/accounts-privacy.md')
      home = config.base.startsWith('/') ? config.base : '../'
      routeBase = config.base.startsWith('/') ? config.base : '/'
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return next()
        const url = new URL(request.url ?? '/', 'http://localhost')
        const canonical = `${routeBase}privacy/`
        if (url.pathname === `${routeBase}privacy` || url.pathname === `${canonical}index.html`) {
          response.writeHead(308, { Location: canonical + url.search }).end()
          return
        }
        const asset = STATIC_ASSETS.find(asset => url.pathname === canonical + asset.name)
        if (url.pathname !== canonical && !asset) return next()
        try {
          const body = asset ? readFileSync(asset.source) : render()
          response.setHeader('Content-Type', asset?.type ?? 'text/html; charset=utf-8')
          response.setHeader('Referrer-Policy', 'no-referrer')
          response.end(request.method === 'HEAD' ? undefined : body)
        } catch (error) { next(error) }
      })
    },
    generateBundle: {
      // Emit actual brand assets with the policy so offline reads need no planner JavaScript
      // All resources must exist before offline's post hook records core bytes and hashes
      order: 'pre',
      handler() {
        this.addWatchFile(sourcePath)
        this.emitFile({ type: 'asset', fileName: PAGE_ASSET, source: render() })
        for (const asset of STATIC_ASSETS) {
          this.addWatchFile(fileURLToPath(asset.source))
          this.emitFile({ type: 'asset', fileName: `privacy/${asset.name}`, source: readFileSync(asset.source) })
        }
      },
    },
  }
}
