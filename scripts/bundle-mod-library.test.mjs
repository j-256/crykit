import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { bundleModDirectory, checkModLibrary, inspectModSource } from './bundle-mod-library.mjs'

const project = (version = '1') => ({ ID: 'synthetic-project', Title: 'Synthetic mod', Version: version, EditorVersion: 34, FutureSetting: { enabled: false, quantity: null }, Passives: [{ ID: 900, Name: 'Synthetic passive', PP: 0 }], Entities: [{ ID: 1, Name: 'Synthetic actor', Message: '@' + ['C', 'Astley.Name'].join('@') + ' @V.Sep @I20.Name' }] })

test('scans nested directories, deduplicates exact bytes, retains revisions, and checks without originals', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-mod-library-'))
  const input = join(directory, 'input')
  const output = join(directory, 'assets')
  const manifest = join(directory, 'manifest.json')
  try {
    await mkdir(join(input, 'nested'), { recursive: true })
    const original = Buffer.from(`\ufeff${JSON.stringify(project(), null, 2).replaceAll('\n', '\r\n')}\r\n`)
    await writeFile(join(input, 'one.json'), original)
    await writeFile(join(input, 'nested', 'duplicate.JSON'), original)
    await writeFile(join(input, 'nested', 'two.json'), JSON.stringify(project('2')))
    await writeFile(join(input, 'other.json'), '{"schemaVersion":1}')
    await writeFile(join(input, 'readme.txt'), 'Unrelated text')
    assert.deepEqual(await bundleModDirectory(input, output, manifest), { mods: 2, duplicates: 1, skipped: 1 })
    const generated = JSON.parse(await readFile(manifest, 'utf8'))
    const first = generated.mods.find(source => source.version === '1')
    const asset = JSON.parse(await readFile(join(output, `${first.sha256}.json`), 'utf8'))
    assert.deepEqual(gunzipSync(Buffer.from(asset.data, 'base64')), original)
    const manifestBytes = await readFile(manifest)
    assert.equal(manifestBytes.includes(Buffer.from(directory)), false)
    await bundleModDirectory(input, output, manifest)
    assert.deepEqual(await readFile(manifest), manifestBytes)
    await rename(input, join(directory, 'unavailable'))
    assert.deepEqual(await checkModLibrary(output, manifest), { mods: 2 })
    await mkdir(input)
    await writeFile(join(input, 'new-revision.json'), JSON.stringify(project('3')))
    assert.deepEqual(await bundleModDirectory(input, output, manifest), { mods: 3, skipped: 0, duplicates: 0 })
    assert.deepEqual(await checkModLibrary(output, manifest), { mods: 3 })
    asset.data = Buffer.from('{}').toString('base64')
    await writeFile(join(output, `${first.sha256}.json`), JSON.stringify(asset))
    await assert.rejects(checkModLibrary(output, manifest))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('rejects private content and invalid identities without altering a generated library', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-mod-library-failure-'))
  const input = join(directory, 'input')
  const output = join(directory, 'assets')
  const manifest = join(directory, 'manifest.json')
  try {
    await mkdir(input)
    await writeFile(join(input, 'valid.json'), JSON.stringify(project()))
    await bundleModDirectory(input, output, manifest)
    const before = await readFile(manifest)
    for (const value of [{ ...project(), Notes: ['person', 'private.invalid'].join('@') }, { ...project(), Notes: ['C:', 'Users', 'Private', 'mod.json'].join(String.fromCharCode(92)) }, { ...project(), Passives: [project().Passives[0], project().Passives[0]] }, JSON.parse('{"ID":"synthetic","Title":"Synthetic","EditorVersion":34,"__proto__":{}}')]) {
      await writeFile(join(input, 'bad.json'), JSON.stringify(value))
      await assert.rejects(bundleModDirectory(input, output, manifest))
      assert.deepEqual(await readFile(manifest), before)
    }
    assert.throws(() => inspectModSource(Buffer.from([0xff, 0xfe])))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('CLI accepts help and equivalent option forms and reports usage failures on stderr', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crykit-mod-library-cli-'))
  const input = join(directory, 'input')
  const output = join(directory, 'assets')
  const manifest = join(directory, 'manifest.json')
  const cli = (...args) => execFileSync(process.execPath, ['scripts/bundle-mod-library.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await mkdir(input)
    await writeFile(join(input, 'mod.json'), JSON.stringify(project()))
    assert.match(cli('-h'), /Usage:/)
    assert.match(cli('--help'), /No mod code is executed/)
    assert.match(cli(`-i${input}`, `--output-directory=${output}`, '-m', manifest, '--'), /"mods":1/)
    assert.match(cli('-co', output, `--manifest=${manifest}`), /"mods":1/)
    for (const args of [[], ['--bad'], ['--input-directory='], ['-i'], ['-c', '-i', input], ['--', '-c']]) assert.throws(() => cli(...args), error => error.status === 2 && error.stdout === '')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
