import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptureUsageError, createRunDirectory, isReviewSourcePath, parseCaptureOptions, renderReviewIndex, sourceIdentity, workingSourceDigest } from './capture-ui.mjs'

const SCRIPT = new URL('./capture-ui.mjs', import.meta.url)

test('CLI option forms select the same focused review without dropping interleaved options', () => {
  const output = join(tmpdir(), 'crykit-review-root')
  const split = parseCaptureOptions(['-l', 'major-change', '--screens', 'save-editor,mods', '-d', 'desktop', '--output', output, '--url', 'http://127.0.0.1:5222'])
  const joined = parseCaptureOptions(['-lmajor-change', '--screens=save-editor,mods', '-ddesktop', `-o${output}`, '-uhttp://127.0.0.1:5222'])
  assert.deepEqual(joined, split)
  assert.equal(split.url, 'http://127.0.0.1:5222/')
  assert.deepEqual(split.screens, ['save-editor', 'mods'])
  assert.deepEqual(parseCaptureOptions(['--screens', 'mods,mods']).screens, ['mods'])
  assert.equal(parseCaptureOptions(['--label', 'valid', '--']).label, 'valid')
  assert.equal(parseCaptureOptions(['-hlmajor-change']).help, true)
})

test('unsafe URLs, unknown screens, positional arguments, empty values, and path-like labels are usage errors', () => {
  for (const args of [
    ['--url', 'https://example.com'], ['--url', 'http://127.0.0.1:5222/#/mods'], ['--url', 'http://user:password@localhost'],
    ['--url', 'file:///tmp/index.html'], ['--screens', 'unknown'], ['--devices', 'phone'], ['--label', '../before'],
    ['--screens='], ['--output='], ['--label'], ['--unknown'], ['--', '--help'], ['unrequested.sav'],
  ]) assert.throws(() => parseCaptureOptions(args), CaptureUsageError)
})

test('persistent default output follows the XDG data root', () => {
  const data = join(tmpdir(), 'xdg-review-data')
  assert.equal(parseCaptureOptions([], { XDG_DATA_HOME: data }).output, join(data, 'crykit', 'ui-reviews'))
})

test('identical labels and timestamps create distinct directories and preserve existing screenshots', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'crykit-ui-capture-test-'))
  try {
    const date = new Date('2026-01-02T03:04:05.000Z')
    const first = await createRunDirectory(temporary, 'before', date)
    await writeFile(join(first, 'existing-screenshot.png'), 'Retained synthetic screenshot')
    const second = await createRunDirectory(temporary, 'before', date)
    assert.notEqual(first, second)
    assert.equal(second, `${first}-2`)
    assert.match(first, /2026-01-02T03-04-05Z-before$/)
    assert.equal(await readFile(join(first, 'existing-screenshot.png'), 'utf8'), 'Retained synthetic screenshot')
    await assert.rejects(access(join(second, 'existing-screenshot.png')), { code: 'ENOENT' })
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('capture source identity records real Git objects and working-change metadata', () => {
  const identity = sourceIdentity()
  assert.ok(identity.branch)
  assert.match(identity.head, /^[a-f0-9]{40}$/)
  assert.match(identity.tree, /^[a-f0-9]{40}$/)
  assert.equal(typeof identity.dirty, 'boolean')
  assert.match(identity.workingChangesDigest, /^[a-f0-9]{64}$/)
})

test('changing an already-untracked source changes review identity while status and tracked diff stay equal', () => {
  const before = workingSourceDigest('?? src/NewPanel.tsx\n', '', [{ path: 'src/NewPanel.tsx', bytes: Buffer.from('Visible original controls') }])
  const after = workingSourceDigest('?? src/NewPanel.tsx\n', '', [{ path: 'src/NewPanel.tsx', bytes: Buffer.from('Visible updated controls') }])
  assert.notEqual(after, before)
})

test('untracked identity checks exclude personal files, generated screenshots, and private configuration', () => {
  for (const path of ['party.sav', 'src/personal-save.sav', 'src/player-screenshot.png', 'ui-reviews/example.png', 'imports/source.json', '.env.local', 'src/secrets.json']) assert.equal(isReviewSourcePath(path), false)
  for (const path of ['src/ui/Panel.tsx', 'src/styles.css', 'scripts/capture-ui.mjs', 'playwright.screenshots.config.ts', 'package.json']) assert.equal(isReviewSourcePath(path), true)
})

test('review index links actual PNGs and escapes failure text instead of executing imported markup', () => {
  const index = renderReviewIndex({ label: 'review', startedAt: 'synthetic timestamp', status: 'Incomplete', captures: [{ device: 'mobile', screen: 'mods', state: 'expanded', description: 'A synthetic state', viewport: 'mobile--mods--viewport.png', fullContent: 'mobile--mods--full-content.png' }], failures: [{ device: 'desktop', screen: 'mods', error: '<script>unsafe</script>', image: 'desktop--mods--failure.png' }] })
  assert.match(index, /href="mobile--mods--full-content.png"/)
  assert.match(index, /src="mobile--mods--viewport.png"/)
  assert.match(index, /href="desktop--mods--failure.png"/)
  assert.match(index, /&lt;script&gt;unsafe&lt;\/script&gt;/)
  assert.doesNotMatch(index, /<script>/)
})

test('both help flags succeed on stdout and invalid usage fails distinctly on stderr', () => {
  for (const flag of ['-h', '--help']) {
    const result = spawnSync(process.execPath, [SCRIPT.pathname, flag], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage: npm run screenshots/)
    assert.equal(result.stderr, '')
  }
  const result = spawnSync(process.execPath, [SCRIPT.pathname, '--url=https://example.com'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /loopback HTTP URL/)
})

test('help remains available without browser packages while capture reports a missing dependency', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'crykit-ui-capture-dependencies-'))
  try {
    const directory = join(temporary, 'scripts')
    await mkdir(directory)
    await copyFile(SCRIPT, join(directory, 'capture-ui.mjs'))
    await copyFile(new URL('./ui-review-screens.json', import.meta.url), join(directory, 'ui-review-screens.json'))
    const help = spawnSync(process.execPath, [join(directory, 'capture-ui.mjs'), '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0)
    assert.equal(help.stderr, '')
    const capture = spawnSync(process.execPath, [join(directory, 'capture-ui.mjs'), '--screens=save-editor'], { encoding: 'utf8' })
    assert.equal(capture.status, 3)
    assert.equal(capture.stdout, '')
    assert.match(capture.stderr, /Screenshot dependency unavailable/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})
