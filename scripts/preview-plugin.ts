import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

export function previewPlugin(): Plugin {
  let outputDirectory = 'dist'
  let enabled = false
  let revision = ''
  return {
    name: 'crykit-preview',
    apply: 'build',
    configResolved(config) {
      enabled = process.env.CRYKIT_PREVIEW === '1'
      outputDirectory = config.build.outDir
      if (!enabled) return
      const head = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim()
      const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
      revision = `${head}${dirty ? ' + local changes' : ''}`
    },
    transformIndexHtml() {
      if (!enabled) return []
      return [
        { tag: 'meta', attrs: { name: 'crykit-preview', content: revision }, injectTo: 'head' },
        { tag: 'meta', attrs: { name: 'robots', content: 'noindex, nofollow' }, injectTo: 'head' },
      ]
    },
    writeBundle() {
      if (!enabled) return
      const path = join(outputDirectory, '_headers')
      const headers = readFileSync(path, 'utf8')
      if (!headers.startsWith('/*\n')) throw new Error('Preview requires the application-wide security header block')
      writeFileSync(path, headers.replace('/*\n', '/*\n  X-Robots-Tag: noindex, nofollow\n'))
    },
  }
}
