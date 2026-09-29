import { createHash } from 'node:crypto'
import { stripHtmlComments } from './wiki-markup.mjs'

export const WIKI_ORIGIN = 'https://crystal-project.fandom.com'
export const IMAGE_ORIGIN = 'https://static.wikia.nocookie.net'
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024
export const MAX_DIMENSION = 2048
export const SPRITE_KINDS = new Set(['class', 'item', 'monster', 'status'])
export const EQUIPMENT_TEMPLATES = ['Axe', 'Book', 'Bow', 'Dagger', 'Heavy armor', 'Heavy helmet', 'Katana', 'Light hat', 'Medium armor', 'Medium headgear', 'Rapier', 'Scythe', 'Shield', 'Spear', 'Staff', 'Sword', 'Wand'].map(name => `Template:${name} link`)
export const STATUS_TEMPLATES = ['Buff', 'Debuff', 'Stance', 'Status effect'].map(name => `Template:${name} link`)
export const TEMPLATE_TITLES = [...EQUIPMENT_TEMPLATES, ...STATUS_TEMPLATES, 'Template:MonsterBox2']
export const ASSET_FILE_PATTERN = /^[a-f0-9]{64}\.(?:png|gif|webp)$/
const EXTENSIONS = new Map([['image/png', 'png'], ['image/gif', 'gif'], ['image/webp', 'webp']])

export const hash = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex')
export const normalize = value => value.normalize('NFKC').replaceAll('_', ' ').replace(/\s+/g, ' ').trim().toLowerCase()
export const wikiUrl = (title, revisionId) => `${WIKI_ORIGIN}/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}${revisionId ? `?oldid=${revisionId}` : ''}`

function source(page, locator) {
  return { title: page.title, revisionId: page.revisionId, url: wikiUrl(page.title, page.revisionId), locator }
}

function templateBody(content, name) {
  const markup = stripHtmlComments(content).replace(/<nowiki\b[^>]*>[\s\S]*?<\/nowiki>/gi, '')
  const start = new RegExp(`\\{\\{${name}(?=\\s*[|}])`, 'i').exec(markup)
  if (!start) return undefined
  let depth = 1
  for (let index = start.index + start[0].length; index < markup.length - 1; index += 1) {
    const pair = markup.slice(index, index + 2)
    if (pair === '{{') { depth += 1; index += 1 }
    else if (pair === '}}') {
      depth -= 1
      if (depth === 0) return markup.slice(start.index + start[0].length, index)
      index += 1
    }
  }
  throw new Error(`Unclosed ${name} template`)
}

function infoboxImage(body, field) {
  if (!body) return undefined
  const match = new RegExp(`(?:^|\\n)\\s*\\|${field}\\s*=\\s*\\[\\[(?:(?:File|Image):)?([^\\]|]+\\.(?:png|gif|webp))(?:\\|[^\\]]*)?\\]\\]\\s*(?=\\n|$)`, 'i').exec(body)
  return match?.[1].trim()
}

// Read only the literal filename cases in the wiki's icon switch templates
export function switchMappings(page) {
  const block = /\[\[File:\{\{#switch:\{\{lc:\{\{\{1\}\}\}\}\}\s*\n([\s\S]*?)\n\}\}/i.exec(page.content)?.[1]
  if (!block) throw new Error(`Unsupported icon mapping in ${page.title}`)
  const mappings = []
  for (const line of block.split('\n')) {
    if (!line.trim() || /^\|#default=\s*$/.test(line.trim())) continue
    const match = /^\|([^={}]+)=([^{}|]+\.(?:png|gif|webp))\s*$/i.exec(line.trim())
    if (!match) throw new Error(`Unsupported icon case in ${page.title}: ${line}`)
    for (const name of match[1].split('|')) mappings.push({ name: normalize(name), title: `File:${match[2].trim()}`, source: source(page, name.trim()) })
  }
  if (!mappings.length) throw new Error(`Empty icon mapping in ${page.title}`)
  return mappings
}

export function spriteCandidates(entities, pages, templates) {
  const mappings = new Map()
  for (const page of templates.filter(page => page.title !== 'Template:MonsterBox2')) {
    const kind = EQUIPMENT_TEMPLATES.includes(page.title) ? 'item' : STATUS_TEMPLATES.includes(page.title) ? 'status' : undefined
    if (!kind) continue
    for (const mapping of switchMappings(page)) {
      const key = `${kind}:${mapping.name}`
      mappings.set(key, [...(mappings.get(key) ?? []), mapping])
    }
  }
  const monsterTemplate = templates.find(page => page.title === 'Template:MonsterBox2')
  const monsterRule = monsterTemplate?.content.includes('[[File:{{PAGENAME}}.png]]')
  const byRevision = new Map(pages.map(page => [page.revisionId, page]))
  const candidates = []
  const unmatched = []
  for (const entity of entities.filter(entity => SPRITE_KINDS.has(entity.kind))) {
    let options = mappings.get(`${entity.kind}:${normalize(entity.name)}`) ?? []
    if (entity.kind === 'class' || entity.kind === 'monster') {
      options = []
      for (const reference of entity.legacy?.wiki?.pages ?? []) {
        if (normalize(reference.title) !== normalize(entity.name)) continue
        const page = byRevision.get(reference.revisionId)
        if (!page) throw new Error(`Missing pinned page for ${entity.name}: revision ${reference.revisionId}`)
        if (entity.kind === 'class') {
          const image = infoboxImage(templateBody(page.content, 'Class'), 'image')
          if (image) options.push({ title: `File:${image}`, sources: [source(page, 'Class infobox image')] })
        }
        if (entity.kind === 'monster' && templateBody(page.content, 'MonsterBox2')) {
          if (!monsterRule) throw new Error('The MonsterBox2 image rule changed; review the template before refreshing')
          options.push({ title: `File:${page.title}.png`, sources: [source(page, 'MonsterBox2'), source(monsterTemplate, 'File:PAGENAME.png')] })
        }
        if (entity.kind === 'monster') {
          const image = infoboxImage(templateBody(page.content, 'MonsterBox'), 'image1')
          if (image) options.push({ title: `File:${image}`, sources: [source(page, 'MonsterBox infobox image')] })
        }
      }
    }
    const titles = [...new Set(options.map(option => normalize(option.title)))]
    if (titles.length !== 1) {
      unmatched.push({ id: entity.id, kind: entity.kind, name: entity.name, reason: titles.length ? 'Conflicting explicit sprite mappings' : 'No explicit sprite mapping in supported wiki sources' })
      continue
    }
    candidates.push({ id: entity.id, kind: entity.kind, name: entity.name, title: options[0].title, sources: options.flatMap(option => option.sources ?? [option.source]) })
  }
  return { candidates, unmatched }
}

export function originalImageUrl(value, mime) {
  const url = new URL(value)
  if (url.origin !== IMAGE_ORIGIN || !url.pathname.startsWith('/crystal-project/images/') || url.username || url.password) throw new Error('Unexpected wiki image origin or path')
  // The CDN converts GIF/PNG to WebP by default, and some uploaded WebP to PNG with format=original
  if (mime === 'image/webp') url.searchParams.delete('format')
  else url.searchParams.set('format', 'original')
  return url.href
}

export function validateImage(bytes, info) {
  const extension = EXTENSIONS.get(info.mime)
  if (!extension) throw new Error(`Unsupported image MIME type: ${info.mime}`)
  if (!Number.isInteger(info.width) || !Number.isInteger(info.height) || info.width < 1 || info.height < 1 || info.width > MAX_DIMENSION || info.height > MAX_DIMENSION) throw new Error('Invalid or oversized sprite dimensions')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.length !== info.size) throw new Error('Sprite byte length does not match the bounded wiki metadata')
  const signature = extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : extension === 'gif' ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!signature) throw new Error('Sprite bytes do not match the declared image format')
  if (!/^[a-f0-9]{40}$/.test(info.sha1) || hash(bytes, 'sha1') !== info.sha1) throw new Error('Sprite SHA-1 does not match the wiki upload')
  return { file: `${hash(bytes)}.${extension}`, sha256: hash(bytes) }
}

export function downloadedImage(bytes, info, allowPngReencoding = false) {
  try { return { ...validateImage(bytes, info), metadata: info } } catch (error) {
    if (!allowPngReencoding || info.mime !== 'image/png' || !/byte length|SHA-1/.test(error.message)) throw error
    // Older PNG uploads are recompressed by the CDN even with format=original
    if (bytes.length < 24 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR' || bytes.readUInt32BE(16) !== info.width || bytes.readUInt32BE(20) !== info.height) throw new Error('Reencoded PNG dimensions do not match the wiki upload')
    const metadata = { ...info, size: bytes.length, sha1: hash(bytes, 'sha1'), originalSize: info.size, originalSha1: info.sha1, representation: 'cdn-png' }
    return { ...validateImage(bytes, metadata), metadata }
  }
}

export function licenseDeclaration(content) {
  return /\{\{\s*Fairuse\s*(?:\||\}\})/i.test(content)
    ? 'Copyrighted; wiki file marked Fairuse'
    : 'No reviewed license declaration on the wiki file page'
}

export function canonicalEntityIds(entities, starterSource) {
  const records = [...starterSource.matchAll(/^  (\["[^\n]+\]),$/gm)].map(match => JSON.parse(match[1]))
  if (!records.length) throw new Error('The starter identity records could not be read')
  const ids = new Map(records.map(([id, kind, name]) => [`${kind}:${normalize(name)}`, id]))
  return entities.map(entity => ({ ...entity, id: ids.get(`${entity.kind}:${normalize(entity.name)}`) ?? entity.id }))
}
