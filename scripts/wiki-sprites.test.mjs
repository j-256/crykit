import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { canonicalEntityIds, hash, licenseDeclaration, originalImageUrl, spriteCandidates, switchMappings, validateImage } from './wiki-sprites.mjs'

const template = (title, cases) => ({ title, revisionId: 11, content: `[[File:{{#switch:{{lc:{{{1}}}}}\n${cases}\n|#default=\n}}|link=]]` })
const entity = (kind, name, pages = []) => ({ id: `${kind}:${name}`, kind, name, legacy: { wiki: { pages } } })

test('literal icon switches preserve aliases and reject changed template logic', () => {
  const page = template('Template:Buff link', '|shell|shell shield=shell.gif\n|cloak=cloak.webp')
  assert.deepEqual(switchMappings(page).map(({ name, title }) => [name, title]), [['shell', 'File:shell.gif'], ['shell shield', 'File:shell.gif'], ['cloak', 'File:cloak.webp']])
  assert.throws(() => switchMappings(template('Template:Buff link', '|shell={{Unknown}}')), /Unsupported icon case/)
  assert.throws(() => switchMappings({ ...page, content: '<script>untrusted()</script>' }), /Unsupported icon mapping/)
})

test('bindings use explicit kind and source mappings and retain unknown or conflicting artwork', () => {
  const entities = [entity('item', 'Synthetic Blade'), entity('status', 'Shell'), entity('ability', 'Shell'), entity('item', 'Unknown')]
  const templates = [template('Template:Sword link', '|synthetic blade=blade.gif'), template('Template:Buff link', '|shell=shell.webp')]
  const result = spriteCandidates(entities, [], templates)
  assert.deepEqual(result.candidates.map(value => value.id), ['item:Synthetic Blade', 'status:Shell'])
  assert.equal(result.unmatched[0].id, 'item:Unknown')
  const conflict = spriteCandidates(entities, [], [...templates, template('Template:Axe link', '|synthetic blade=axe.gif')])
  assert.equal(conflict.candidates.some(value => value.kind === 'item'), false)
  assert.match(conflict.unmatched[0].reason, /Conflicting/)
})

test('class and monster images require their pinned pages and the verified monster template rule', () => {
  const pages = [
    { title: 'Synthetic Knight', revisionId: 21, content: '{{Class|image=[[knight.webp]]\n}}\n[[File:unrelated.gif]]' },
    { title: 'Synthetic Slime', revisionId: 22, content: 'Introductory text\n{{MonsterBox2\n|HP=50\n}}' },
  ]
  const entities = [entity('class', pages[0].title, [pages[0]]), entity('monster', pages[1].title, [pages[1]])]
  const monsterTemplate = { title: 'Template:MonsterBox2', revisionId: 23, content: '[[File:{{PAGENAME}}.png]]' }
  const result = spriteCandidates(entities, pages, [monsterTemplate])
  assert.deepEqual(result.candidates.map(value => value.title), ['File:knight.webp', 'File:Synthetic Slime.png'])
  assert.equal(result.candidates[1].sources[0].revisionId, 22)
  assert.equal(result.candidates[1].sources[1].revisionId, 23)
  assert.throws(() => spriteCandidates(entities, [], [monsterTemplate]), /Missing pinned page/)
  assert.throws(() => spriteCandidates(entities, pages, [{ ...monsterTemplate, content: '[[File:other.png]]' }]), /image rule changed/)
})

test('original image requests are bounded to the wiki CDN and preserve upload formats', () => {
  const url = 'https://static.wikia.nocookie.net/crystal-project/images/a/ab/synthetic.gif/revision/latest?cb=20260101000000'
  assert.match(originalImageUrl(url, 'image/gif'), /format=original/)
  assert.doesNotMatch(originalImageUrl(url.replace('.gif', '.webp'), 'image/webp'), /format=/)
  const credentials = new URL(url)
  credentials.username = 'synthetic'
  credentials.password = 'synthetic'
  for (const value of ['https://example.com/image.gif', 'https://static.wikia.nocookie.net/another-wiki/image.gif', credentials.href]) assert.throws(() => originalImageUrl(value, 'image/gif'))
})

test('image integrity rejects transformed bytes, unsupported formats, and resource limits', () => {
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
  const info = { mime: 'image/gif', size: bytes.length, width: 1, height: 1, sha1: hash(bytes, 'sha1') }
  assert.equal(validateImage(bytes, info).file, `${hash(bytes)}.gif`)
  assert.throws(() => validateImage(Buffer.from('<script>bad()</script>'), { ...info, size: 22 }), /byte length|format/)
  assert.throws(() => validateImage(bytes, { ...info, sha1: '0'.repeat(40) }), /SHA-1/)
  assert.throws(() => validateImage(bytes, { ...info, mime: 'image/svg+xml' }), /Unsupported/)
  assert.throws(() => validateImage(bytes, { ...info, width: 5000 }), /dimensions/)
  assert.throws(() => validateImage(bytes, { ...info, size: bytes.length + 1 }), /byte length/)
})

test('artwork rights remain independent of the wiki text license', () => {
  assert.equal(licenseDeclaration('{{Fairuse}}'), 'Copyrighted; wiki file marked Fairuse')
  assert.equal(licenseDeclaration(''), 'No reviewed license declaration on the wiki file page')
  assert.doesNotMatch(licenseDeclaration('[[Category:Images]]'), /CC-BY-SA/)
})

test('starter identities are matched by exact kind and normalized name', () => {
  const source = '  ["base:item:blade", "item", "Synthetic Blade", "wiki-weapons"],'
  const mapped = canonicalEntityIds([entity('item', 'Synthetic Blade'), entity('ability', 'Synthetic Blade')], source)
  assert.equal(mapped[0].id, 'base:item:blade')
  assert.equal(mapped[1].id, 'ability:Synthetic Blade')
})

test('CLI help and invalid options have distinct output streams and exit statuses', () => {
  const script = fileURLToPath(new URL('./update-wiki-sprites.mjs', import.meta.url))
  for (const args of [['-h'], ['--help'], ['-ch']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /Usage:/)
    assert.equal(result.stderr, '')
  }
  for (const args of [['--unknown'], ['--cache=yes'], ['--cache', '--check'], ['--', '--help'], ['extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.equal(result.stdout, '')
    assert.notEqual(result.stderr, '')
  }
})
