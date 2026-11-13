import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { IMPORT_INTERPRETATION } from './import-interpretations'

it('freezes the complete projection dependency graph and parser versions for each interpretation', async () => {
  // Runtime import discovery includes new helper and data dependencies automatically
  // No output is written, and external packages are recorded by installed version
  const result = await build({ entryPoints: ['src/interchange/crystal-edit.ts', 'src/interchange/research.ts', 'src/interchange/normalize-xlsx.ts'], outdir: 'unused', bundle: true, write: false, packages: 'external', metafile: true, logLevel: 'silent' })
  const inputs = Object.fromEntries(await Promise.all(Object.keys(result.metafile.inputs).sort().map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
  const packages = [...new Set(Object.values(result.metafile.inputs).flatMap(input => input.imports.filter(dependency => dependency.external).map(dependency => dependency.path)))].sort()
  const dependencies = Object.fromEntries(await Promise.all(packages.map(async name => [name, JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version as string])))
  await expect(`${JSON.stringify({ interpretation: IMPORT_INTERPRETATION, dependencies, inputs }, null, 2)}\n`).toMatchFileSnapshot(`./import-interpretation-${IMPORT_INTERPRETATION}.json`)
})
