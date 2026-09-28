import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Plugin } from 'vite'

interface LockedPackage { readonly dev?: boolean; readonly version?: string; readonly license?: string }

export function softwareLicenses(): Plugin {
  let root = '.'
  return {
    name: 'crystal-companion-software-licenses',
    apply: 'build',
    configResolved(config) { root = config.root },
    generateBundle() {
      const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, LockedPackage> }
      const notices = ['Crystal Companion dependency notices', 'These notices describe third-party software, not game artwork or wiki content. Package license declarations and supplied license files follow.']
      for (const [path, entry] of Object.entries(lock.packages)) {
        if (!path || entry.dev) continue
        const directory = join(root, path)
        const files = readdirSync(directory).filter(name => /^(licen[cs]e|copying|notice)(\.[a-z]+)?$/i.test(name)).sort()
        notices.push(`${path.replace(/^node_modules\//, '')} ${entry.version ?? ''}\nDeclared license: ${entry.license ?? 'unspecified'}`)
        for (const file of files) notices.push(`${file}\n${readFileSync(join(directory, file), 'utf8')}`)
      }
      this.emitFile({ type: 'asset', fileName: 'third-party-licenses.txt', source: notices.join('\n\n-----\n\n') + '\n' })
    },
  }
}
