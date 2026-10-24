import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import type { TestProject } from 'vitest/node'

export default function setup(project: TestProject): void {
  project.onTestsRerun(specifications => {
    if (!specifications.some(specification => specification.project.name === project.name)) return
    // Vitest awaits this hook before running files, so fixtures cannot read a stale bundle
    execFileSync(process.execPath, [resolve(project.config.root, 'scripts/build-account-tests.mjs')], { cwd: project.config.root, stdio: 'inherit' })
  })
}
