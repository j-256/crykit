#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripHtmlComments, stripHtmlTags } from './wiki-markup.mjs'

const API_URL = 'https://crystal-project.fandom.com/api.php'
const WIKI_ROOT = 'https://crystal-project.fandom.com/wiki/'
const USER_AGENT = 'CrystalCompanionCatalogResearch/0.1 (personal offline fan planner)'
const WIKI_APPLICABILITY = 'Community wiki evidence; Nintendo Switch and enabled-mod applicability are unverified'
const BATCH_SIZE = 50
const CACHE_SCHEMA = 1
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_DIR = dirname(SCRIPT_DIR)
const CACHE_PATH = join(PROJECT_DIR, '.wiki-cache', 'pages.json')
const OUTPUT_PATH = join(PROJECT_DIR, 'src', 'catalog', 'wiki-data.json')
const STARTER_DATA_PATH = join(PROJECT_DIR, 'src', 'catalog', 'data.ts')
const SWITCH_DATA_PATH = join(PROJECT_DIR, 'src', 'catalog', 'switch-data.json')

const ITEM_CATEGORY_ROOTS = new Set([
  'Accessories',
  'Armors',
  'Consumables',
  'Items',
  'Key Items',
  'Tools',
  'Weapons',
])

const ITEM_CATEGORY_EXCLUSIONS = new Set([
  'Armor icons',
  'Item icons',
  'Weapon icons',
])

const PAGE_KIND_CATEGORIES = new Map([
  ['Basic attacks', 'ability'],
  ['Abilities', 'ability'],
  ['Areas', 'location'],
  ['Buffs', 'status'],
  ['Classes', 'class'],
  ['Commands', 'command'],
  ['Debuffs', 'status'],
  ['Monsters', 'monster'],
  ['Stances', 'status'],
  ['Status Effects', 'status'],
  ['Triggered abilities', 'ability'],
])

const PAGE_KIND_OVERRIDES = new Map([
  ['Deity Eye', 'item'],
  ['Quintar Ocarina', 'item'],
])

const WIKI_MAINTENANCE_CATEGORIES = new Set([
  '{{SITENAME}}',
  'Candidates for deletion',
  'Crystal Project Wiki',
  'Disambiguations',
  'Pages with broken file links',
])

const META_PAGE_TITLES = new Set([
  '2subtest',
  'Community',
  'Crystal Project Wiki',
  'Main Page',
  'MonsterBox2 clone for testing',
  'Site rules',
  'TemplateTest',
])

const COLLECTION_PAGE_TITLES = new Set([
  'Accessories',
  'Areas',
  'Classes',
  'Consumables',
  'Equipment',
  'Items',
  'Key Items',
  'Maps',
  'Monsters',
  'Tools',
])

const IGNORED_LINK_NAMESPACES = new Set([
  'Category',
  'File',
  'Help',
  'Image',
  'Map',
  'Media',
  'Special',
  'Template',
  'User',
])

const EXPECTED_FIELDS = Object.freeze({
  ability: ['Class', 'Category', 'Learning cost', 'Cost', 'Type', 'Description'],
  class: ['Crystal', 'Master', 'Command', 'Innate passive(s)', 'Weapons', 'Armor', 'Initial equipment', 'Total LP to master', 'Stat growth'],
  command: ['Class', 'Description'],
  item: ['Category', 'Description', 'Location'],
  location: ['Description'],
  monster: ['Level', 'HP', 'Location', 'Abilities', 'Drops', 'Steals'],
  monsterMagic: ['Class', 'Category', 'Learning cost', 'Cost', 'Type', 'Description'],
  passive: ['Class', 'Category', 'Learning cost', 'PP cost', 'Description'],
  status: ['Category', 'Effect'],
})

function normalizeTypography(value) {
  return value
    .replaceAll('\u2018', "'")
    .replaceAll('\u2019', "'")
    .replaceAll('\u201c', '"')
    .replaceAll('\u201d', '"')
    .replaceAll('\u2013', ' - ')
    .replaceAll('\u2014', ' - ')
    .replaceAll('\u2212', '-')
    .replaceAll('\u00a0', ' ')
}

function normalizedName(value) {
  return normalizeTypography(value).normalize('NFKC').replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
}

function slug(value) {
  const result = normalizedName(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return result || createHash('sha256').update(value).digest('hex').slice(0, 12)
}

function titleCase(value) {
  return normalizedName(value)
    .replace(/[-_]+/g, ' ')
    .replace(/^\w/, (character) => character.toLocaleUpperCase())
}

function canonicalFieldName(value) {
  const name = normalizedName(value).replace(/:$/, '')
  const fixed = new Map([
    ['initial equipment', 'Initial equipment'],
    ['innate passive(s)', 'Innate passive(s)'],
    ['innate passives', 'Innate passive(s)'],
  ])
  return fixed.get(name.toLocaleLowerCase()) ?? titleCase(name)
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stableJson(nested)]))
}

function jsonEqual(left, right) {
  return JSON.stringify(stableJson(left)) === JSON.stringify(stableJson(right))
}

function unique(values) {
  return [...new Set(values)]
}

function chunks(values, size) {
  const result = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

async function api(parameters) {
  const body = new URLSearchParams({ ...parameters, format: 'json', formatversion: '2' })
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    },
    body,
  })
  if (!response.ok) throw new Error(`MediaWiki request failed with HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.error) throw new Error(`MediaWiki request failed: ${payload.error.code}: ${payload.error.info}`)
  return payload
}

async function allPageTitles() {
  const titles = []
  let continuation = {}
  do {
    const payload = await api({
      action: 'query',
      list: 'allpages',
      apnamespace: '0',
      aplimit: 'max',
      ...continuation,
    })
    titles.push(...payload.query.allpages.map((page) => page.title))
    continuation = payload.continue ?? {}
  } while (Object.keys(continuation).length > 0)
  return titles.sort((left, right) => left.localeCompare(right))
}

async function categoryTree(rootCategories) {
  const discovered = new Set(rootCategories)
  const pending = [...rootCategories]
  while (pending.length > 0) {
    const category = pending.shift()
    let continuation = {}
    do {
      const payload = await api({
        action: 'query',
        list: 'categorymembers',
        cmtitle: `Category:${category}`,
        cmtype: 'subcat',
        cmlimit: 'max',
        ...continuation,
      })
      for (const member of payload.query.categorymembers) {
        const name = normalizedName(member.title.replace(/^Category:/, ''))
        if (ITEM_CATEGORY_EXCLUSIONS.has(name) || discovered.has(name)) continue
        discovered.add(name)
        pending.push(name)
      }
      continuation = payload.continue ?? {}
    } while (Object.keys(continuation).length > 0)
  }
  return [...discovered].sort((left, right) => left.localeCompare(right))
}

async function fetchPageBatch(titles) {
  const pages = new Map()
  let continuation = {}
  do {
    const payload = await api({
      action: 'query',
      titles: titles.join('|'),
      prop: 'categories|info|revisions',
      cllimit: 'max',
      inprop: 'url',
      rvprop: 'ids|timestamp|content',
      rvslots: 'main',
      ...continuation,
    })
    for (const page of payload.query.pages) {
      const existing = pages.get(page.pageid)
      const revision = page.revisions?.[0]
      pages.set(page.pageid, {
        pageId: page.pageid,
        title: normalizedName(page.title),
        url: page.fullurl,
        revisionId: revision?.revid ?? existing?.revisionId,
        revisedAt: revision?.timestamp ?? existing?.revisedAt,
        content: revision?.slots?.main?.content ?? existing?.content ?? '',
        categories: unique([
          ...(existing?.categories ?? []),
          ...(page.categories ?? []).map((category) => normalizedName(category.title.replace(/^Category:/, ''))),
        ]).sort((left, right) => left.localeCompare(right)),
      })
    }
    continuation = payload.continue ?? {}
  } while (Object.keys(continuation).length > 0)
  return [...pages.values()]
}

async function fetchWiki() {
  const sitePayload = await api({ action: 'query', meta: 'siteinfo', siprop: 'general|statistics|rightsinfo' })
  const [titles, itemCategories] = await Promise.all([
    allPageTitles(),
    categoryTree([...ITEM_CATEGORY_ROOTS]),
  ])
  const pages = []
  let completed = 0
  for (const batch of chunks(titles, BATCH_SIZE)) {
    pages.push(...await fetchPageBatch(batch))
    completed += batch.length
    process.stdout.write(`\rFetched ${completed}/${titles.length} wiki pages`)
  }
  process.stdout.write('\n')
  return {
    schema: CACHE_SCHEMA,
    site: {
      name: sitePayload.query.general.sitename,
      generator: sitePayload.query.general.generator,
      rights: sitePayload.query.rightsinfo.text,
      rightsUrl: sitePayload.query.rightsinfo.url,
      articleCount: sitePayload.query.statistics.articles,
    },
    itemCategories,
    pages: pages.sort((left, right) => left.title.localeCompare(right.title)),
  }
}

async function loadSource(useCache) {
  if (useCache) {
    const cached = JSON.parse(await readFile(CACHE_PATH, 'utf8'))
    if (cached.schema !== CACHE_SCHEMA) throw new Error('The wiki cache schema is stale')
    return cached
  }
  const source = await fetchWiki()
  await mkdir(dirname(CACHE_PATH), { recursive: true })
  await writeFile(CACHE_PATH, `${JSON.stringify(source)}\n`)
  return source
}

function splitTopLevel(value, delimiter) {
  const parts = []
  let braceDepth = 0
  let bracketDepth = 0
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    const pair = value.slice(index, index + 2)
    if (pair === '{{') {
      braceDepth += 1
      index += 1
      continue
    }
    if (pair === '}}' && braceDepth > 0) {
      braceDepth -= 1
      index += 1
      continue
    }
    if (pair === '[[') {
      bracketDepth += 1
      index += 1
      continue
    }
    if (pair === ']]' && bracketDepth > 0) {
      bracketDepth -= 1
      index += 1
      continue
    }
    if (braceDepth === 0 && bracketDepth === 0 && value.startsWith(delimiter, index)) {
      parts.push(value.slice(start, index))
      start = index + delimiter.length
      index += delimiter.length - 1
    }
  }
  parts.push(value.slice(start))
  return parts
}

function topLevelEquals(value) {
  const parts = splitTopLevel(value, '=')
  if (parts.length < 2) return undefined
  return [parts[0], parts.slice(1).join('=')]
}

function parseTemplate(markup) {
  const content = markup.startsWith('{{') && markup.endsWith('}}') ? markup.slice(2, -2) : markup
  const parts = splitTopLevel(content, '|')
  const parameters = {}
  const positional = []
  for (const part of parts.slice(1)) {
    const pair = topLevelEquals(part)
    if (pair && pair[0].trim()) parameters[normalizedName(pair[0])] = pair[1].trim()
    else positional.push(part.trim())
  }
  return { name: normalizedName(parts[0] ?? ''), parameters, positional }
}

function topLevelTemplates(markup) {
  const templates = []
  let depth = 0
  let start = -1
  for (let index = 0; index < markup.length - 1; index += 1) {
    const pair = markup.slice(index, index + 2)
    if (pair === '{{') {
      if (depth === 0) start = index
      depth += 1
      index += 1
    } else if (pair === '}}' && depth > 0) {
      depth -= 1
      index += 1
      if (depth === 0 && start >= 0) templates.push(parseTemplate(markup.slice(start, index + 1)))
    }
  }
  return templates
}

function decodeEntities(value) {
  const named = new Map([
    ['amp', '&'],
    ['apos', "'"],
    ['gt', '>'],
    ['hellip', '...'],
    ['lt', '<'],
    ['mdash', ' - '],
    ['minus', '-'],
    ['nbsp', ' '],
    ['ndash', ' - '],
    ['quot', '"'],
    ['times', 'x'],
  ])
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return named.get(entity.toLocaleLowerCase()) ?? match
  })
}

function templateText(value) {
  const template = parseTemplate(`{{${value}}}`)
  const name = template.name.toLocaleLowerCase()
  if (name.startsWith('#') || name === 'icon' || name.includes('sprite')) return ''
  if (name === '!') return '|'
  if (name === '=') return '='
  if (name === 'color') return template.positional.at(-1) ?? ''
  if (name === 'element') return template.positional.at(-1) ?? ''
  if (name.endsWith(' link')) return template.positional.at(-1) ?? ''
  if (name === 'copper' || name === 'silver' || name === 'gold') return titleCase(name)
  if (template.positional.length > 0) return template.positional.at(-1) ?? ''
  return ''
}

function plainText(markup) {
  let value = stripHtmlComments(markup)
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref\s*>/gi, '')
    .replace(/<ref\b[^>]*\/\s*>/gi, '')
    .replace(/<sup\b[^>]*>V<\/sup\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:div|p|li|dd|dt|tr|h[1-6])\s*>/gi, '\n')
  for (let pass = 0; pass < 20 && /\{\{[^{}]*\}\}/.test(value); pass += 1) {
    value = value.replace(/\{\{([^{}]*)\}\}/g, (_match, content) => templateText(content))
  }
  value = value
    .replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '')
    .replace(/\[\[#[^\]|]*(?:\|([^\]]+))?\]\]/g, (_match, label) => label ?? '')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]#]+)(?:#[^\]]*)?\]\]/g, '$1')
    .replace(/\[(?:https?:\/\/\S+)(?:\s+([^\]]+))?\]/g, '$1')
    .replace(/'{2,5}/g, '')
    .replace(/^\s*[*#:;]+\s*/gm, '')
    .replace(/^\s*\{\|.*$/gm, '')
    .replace(/^\s*\|\}.*$/gm, '')
    .replace(/^\s*\|-.*$/gm, '')
    .replace(/^\s*[!|+]\s?/gm, '')
  return normalizeTypography(decodeEntities(stripHtmlTags(value)))
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function wikiLinks(markup) {
  const links = []
  for (const match of markup.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const target = normalizedName(match[1].split('#')[0]).replace(/^:/, '')
    if (!target) continue
    const namespace = target.includes(':') ? target.slice(0, target.indexOf(':')) : undefined
    if ((namespace && IGNORED_LINK_NAMESPACES.has(namespace)) || /^w:/i.test(target) || /\.(?:gif|jpe?g|png|webp)$/i.test(target)) continue
    const label = plainText(match[2] ?? target)
    links.push({ target, label })
  }
  return links
}

function extractTables(markup) {
  const tables = []
  let start = 0
  while (start < markup.length) {
    const tableStart = markup.indexOf('{|', start)
    if (tableStart < 0) break
    const tableEnd = markup.indexOf('|}', tableStart + 2)
    if (tableEnd < 0) break
    tables.push(markup.slice(tableStart, tableEnd + 2))
    start = tableEnd + 2
  }
  return tables
}

function splitTableCells(lines, marker) {
  const cells = []
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith(marker) || /^\|(?:[}+\-]|$)/.test(trimmed) || /^!(?:$)/.test(trimmed)) continue
    const content = trimmed.slice(1)
    for (let cell of splitTopLevel(content, marker.repeat(2))) {
      const attributeSeparator = splitTopLevel(cell, '|')
      if (attributeSeparator.length > 1 && /^[^|]*=/.test(attributeSeparator[0])) cell = attributeSeparator.slice(1).join('|')
      cells.push(cell.trim())
    }
  }
  return cells
}

function parseTable(markup) {
  const caption = plainText(markup.match(/^\|\+\s*(.*)$/m)?.[1] ?? '')
  const segments = markup.split(/^\|-.*$/m)
  let headerIndex = segments.findIndex((segment) => splitTableCells(segment.split('\n'), '!').length > 0)
  if (headerIndex < 0) headerIndex = 0
  const headers = splitTableCells(segments[headerIndex].split('\n'), '!').map((value, index) => value.trim() === '#' ? '#' : plainText(value) || `Column ${index + 1}`)
  const rows = []
  for (const segment of segments.slice(headerIndex + 1)) {
    const lines = segment.split('\n')
    const rawCells = [...splitTableCells(lines, '!'), ...splitTableCells(lines, '|')]
    if (rawCells.length === 0) continue
    const cells = rawCells.map((raw, index) => ({
      header: headers[index] ?? `Column ${index + 1}`,
      raw,
      text: plainText(raw),
      links: wikiLinks(raw),
    }))
    if (cells.some((cell) => cell.text)) rows.push(cells)
  }
  return { caption, headers, rows }
}

function extractSections(markup) {
  const matches = [...markup.matchAll(/^(={2,6})\s*(.*?)\s*\1\s*$/gm)]
  const sections = [{ level: 1, title: 'Overview', body: markup.slice(0, matches[0]?.index ?? markup.length) }]
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const bodyStart = match.index + match[0].length
    sections.push({
      level: match[1].length,
      title: plainText(match[2]) || `Section ${index + 1}`,
      body: markup.slice(bodyStart, matches[index + 1]?.index ?? markup.length),
    })
  }
  return sections
}

function withoutTables(markup) {
  let result = markup
  for (const table of extractTables(markup)) result = result.replace(table, '')
  return result
}

function sourceRef(page, locator) {
  const sourceUrl = new URL(page.url ?? `${WIKI_ROOT}${encodeURIComponent(page.title.replaceAll(' ', '_'))}`)
  sourceUrl.searchParams.set('oldid', String(page.revisionId))
  return {
    sourceId: sourceUrl.href,
    ...(locator ? { locator } : {}),
    snapshot: `revision ${page.revisionId}`,
    applicability: WIKI_APPLICABILITY,
  }
}

function known(value, source) {
  return { state: 'known', value, sources: [source] }
}

function unknown(reason, source) {
  return { state: 'unknown', reason, ...(source ? { sources: [source] } : {}) }
}

function fieldValue(markup) {
  const text = plainText(markup)
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text)
  return text
}

function cellByHeader(row, matcher) {
  return row.find((cell) => matcher.test(cell.header))
}

function nameFromCell(cell) {
  if (!cell) return undefined
  const linked = cell.links.find((link) => link.label)?.label
  return normalizedName(linked ?? cell.text.replace(/^\d+\s*/, '')) || undefined
}

function categoryMarkup(content) {
  return [...content.matchAll(/\[\[Category:([^\]|]+)(?:\|[^\]]*)?\]\]/gi)]
    .map((match) => normalizedName(match[1]))
    .filter((category) => category && !/[{}]/.test(category))
}

function pageCategories(page) {
  return unique([...page.categories, ...categoryMarkup(page.content)])
    .filter((category) => !WIKI_MAINTENANCE_CATEGORIES.has(category))
    .sort((left, right) => left.localeCompare(right))
}

function redirectTarget(content) {
  const match = /^\s*#redirect\s*\[\[([^\]]+)\]\]/i.exec(content)
  return match ? normalizedName(match[1].split('#')[0]) : undefined
}

function candidateKey(kind, name) {
  return `${kind}\0${normalizedName(name).toLocaleLowerCase()}`
}

function candidateId(kind, name) {
  return `wiki:${kind}:${slug(name)}`
}

function mergeKnowledge(existing, incoming) {
  if (!existing) return incoming
  if (existing.state === 'unknown') return incoming.state === 'known' ? incoming : existing
  if (incoming.state === 'unknown') return existing
  const claims = []
  const append = (knowledge) => {
    if (knowledge.state === 'known') claims.push({ value: knowledge.value, sources: knowledge.sources ?? [] })
    if (knowledge.state === 'conflicting') claims.push(...knowledge.claims)
  }
  append(existing)
  append(incoming)
  const uniqueClaims = []
  for (const claim of claims) {
    const match = uniqueClaims.find((candidate) => jsonEqual(candidate.value, claim.value))
    if (match) match.sources = unique([...match.sources, ...claim.sources].map((source) => JSON.stringify(source))).map((source) => JSON.parse(source))
    else uniqueClaims.push({ ...claim })
  }
  if (uniqueClaims.length === 1) return { state: 'known', value: uniqueClaims[0].value, sources: uniqueClaims[0].sources }
  return { state: 'conflicting', claims: uniqueClaims }
}

function mergeCandidates(existing, incoming) {
  const fields = { ...existing.fields }
  for (const [name, value] of Object.entries(incoming.fields)) {
    const current = fields[name]
    if (name === 'Category' && current?.state === 'known' && value.state === 'known' && Array.isArray(current.value) && Array.isArray(value.value)) {
      fields[name] = {
        state: 'known',
        value: unique([...current.value, ...value.value]).sort((left, right) => String(left).localeCompare(String(right))),
        sources: unique([...(current.sources ?? []), ...(value.sources ?? [])].map((source) => JSON.stringify(source))).map((source) => JSON.parse(source)),
      }
      continue
    }
    if (name === 'Description' && current?.state === 'known' && value.state === 'known' && typeof current.value === 'string' && typeof value.value === 'string' && current.value !== value.value) {
      const [preferred, additional] = current.value.length >= value.value.length ? [current, value] : [value, current]
      fields.Description = preferred
      fields['Additional descriptions'] = mergeKnowledge(fields['Additional descriptions'], known([additional.value], additional.sources?.[0]))
      continue
    }
    fields[name] = mergeKnowledge(current, value)
  }
  const sources = unique([...existing.sources, ...incoming.sources].map((source) => JSON.stringify(source))).map((source) => JSON.parse(source))
  return {
    ...existing,
    aliases: unique([...existing.aliases, ...incoming.aliases]).sort((left, right) => left.localeCompare(right)),
    fields,
    ...(existing.rawDescription ? {} : incoming.rawDescription ? { rawDescription: incoming.rawDescription } : {}),
    ...(existing.ppCost ? {} : incoming.ppCost ? { ppCost: incoming.ppCost } : {}),
    sources,
    legacy: {
      wiki: {
        pages: unique([...(existing.legacy?.wiki?.pages ?? []), ...(incoming.legacy?.wiki?.pages ?? [])]),
      },
    },
  }
}

function addCandidate(candidates, candidate) {
  const name = normalizedName(candidate.name)
  if (!name) return
  const key = candidateKey(candidate.kind, name)
  const normalized = {
    id: candidateId(candidate.kind, name),
    kind: candidate.kind,
    name,
    aliases: unique((candidate.aliases ?? []).map(normalizedName).filter((alias) => alias && alias !== name)).sort((left, right) => left.localeCompare(right)),
    fields: candidate.fields ?? {},
    ...(candidate.rawDescription ? { rawDescription: normalizedName(candidate.rawDescription.replace(/\n+/g, ' ')) } : {}),
    ...(candidate.ppCost ? { ppCost: candidate.ppCost } : {}),
    sources: candidate.sources,
    legacy: candidate.legacy ?? { wiki: { pages: [] } },
  }
  candidates.set(key, candidates.has(key) ? mergeCandidates(candidates.get(key), normalized) : normalized)
}

function primaryKind(page, templates, itemCategories) {
  const override = PAGE_KIND_OVERRIDES.get(page.title)
  if (override) return override
  if (/^\s*===\s*Passive Skill\s*===/im.test(page.content)) return 'passive'
  const categories = new Set(pageCategories(page))
  if (templates.some((template) => template.name.toLocaleLowerCase() === 'monsterbox2')) return 'monster'
  if (templates.some((template) => template.name.toLocaleLowerCase() === 'class')) return 'class'
  if (templates.some((template) => /^(?:armorbox|infobox )/i.test(template.name))) return 'item'
  for (const [category, kind] of PAGE_KIND_CATEGORIES) if (categories.has(category)) return kind
  if ([...categories].some((category) => itemCategories.has(category))) return 'item'
  if ([...categories].some((category) => /shops?$/i.test(category))) return 'location'
  return 'other'
}

function pageDisplayName(page, templates, kind) {
  if (kind === 'item') {
    const infobox = templates.find((template) => /^(?:armorbox|infobox )/i.test(template.name))
    const supplied = infobox?.parameters.name ?? infobox?.parameters.title1 ?? infobox?.parameters.title
    const value = supplied ? plainText(supplied) : ''
    if (value) return value
  }
  return page.title
}

function sectionLocator(page, section) {
  return section.title === 'Overview' ? page.title : `${page.title} > ${section.title}`
}

function genericPageCandidate(page, kind, templates) {
  const sections = extractSections(page.content)
  const source = sourceRef(page, page.title)
  const fields = {}
  const categories = pageCategories(page)
  fields.Category = known(categories.length > 0 ? categories : ['Uncategorized'], source)

  const infobox = templates.find((template) => /^(?:class|monsterbox2|armorbox|infobox )/i.test(template.name))
  if (infobox) {
    for (const [name, markup] of Object.entries(infobox.parameters)) {
      if (/^(?:image|image alt|title|title1|name)$/i.test(name)) continue
      const value = fieldValue(markup)
      if (value === '') continue
      fields[canonicalFieldName(name)] = known(value, source)
    }
    if (kind === 'monster') {
      const indexed = (prefix) => Object.entries(infobox.parameters)
        .filter(([name, value]) => new RegExp(`^${prefix}\\d+$`, 'i').test(name) && plainText(value))
        .sort(([left], [right]) => Number(left.match(/\d+$/)?.[0]) - Number(right.match(/\d+$/)?.[0]))
      const abilities = indexed('ability').map(([, value]) => plainText(value))
      const passives = indexed('passive').map(([, value]) => plainText(value))
      const collectItems = (prefix) => indexed(prefix).map(([name, value]) => {
        const number = name.match(/\d+$/)?.[0]
        const percent = plainText(infobox.parameters[`${prefix}${number} Percent`] ?? '')
        return { item: plainText(value), ...(percent ? { chance: `${percent}%` } : {}) }
      })
      const drops = collectItems('Drop')
      const steals = collectItems('Steal')
      if (abilities.length > 0) fields.Abilities = known(abilities, source)
      if (passives.length > 0) fields.Passives = known(passives, source)
      if (drops.length > 0) fields.Drops = known(drops, source)
      if (steals.length > 0) fields.Steals = known(steals, source)
    }
  }

  let tableIndex = 0
  for (const section of sections) {
    const sectionSource = sourceRef(page, sectionLocator(page, section))
    const text = plainText(withoutTables(section.body))
    if (section.title !== 'Overview' && text) fields[`Section: ${section.title}`] = known(text, sectionSource)
    for (const tableMarkup of extractTables(section.body)) {
      if (kind === 'class' && section.title === 'Stat Growth') continue
      const table = parseTable(tableMarkup)
      if (table.rows.length === 0) continue
      tableIndex += 1
      const tableName = table.caption || section.title || `Table ${tableIndex}`
      const value = table.rows.map((row) => Object.fromEntries(row.filter((cell) => cell.text).map((cell) => [cell.header, cell.text])))
      fields[`Table: ${tableName}${tableIndex > 1 && !table.caption ? ` ${tableIndex}` : ''}`] = known(value, sectionSource)
    }
  }

  const overview = plainText(withoutTables(sections[0]?.body ?? ''))
  const firstSectionText = sections.slice(1).map((section) => plainText(withoutTables(section.body))).find(Boolean)
  const description = overview || firstSectionText || plainText(withoutTables(page.content).replace(/^={2,6}.*?={2,6}$/gm, ''))
  if (description) fields.Description = known(description, source)
  if (kind === 'item' && !fields.Location && /\b(?:chest|drop|found|location|obtain|purchas|reward|shop|steal)\w*\b/i.test(description)) fields.Location = known(description, source)
  if (kind === 'status' && description) fields.Effect = known(description, source)
  const name = pageDisplayName(page, templates, kind)
  return {
    kind,
    name,
    aliases: name === page.title ? [] : [page.title],
    fields,
    rawDescription: description,
    sources: [source],
    legacy: { wiki: { pages: [{ title: page.title, pageId: page.pageId, revisionId: page.revisionId, revisedAt: page.revisedAt }] } },
  }
}

function parseResourceCosts(text) {
  const fields = {}
  for (const [label, pattern] of [
    ['MP cost', /(?:^|\n)(\d+)\s*MP\b/i],
    ['AP cost', /(?:^|\n)(\d+)\s*AP\b/i],
    ['CT', /(?:^|\n)(\d+)\s*CT\b/i],
  ]) {
    const match = pattern.exec(text)
    if (match) fields[label] = Number(match[1])
  }
  return fields
}

function classDetails(page, templates, candidates, issues) {
  const classTemplate = templates.find((template) => template.name.toLocaleLowerCase() === 'class')
  if (!classTemplate) return
  const className = pageDisplayName(page, templates, 'class')
  const classSource = sourceRef(page, page.title)
  const command = plainText(classTemplate.parameters.command ?? '')
  const classFields = {}
  for (const [name, markup] of Object.entries(classTemplate.parameters)) {
    if (/^(?:image|image alt|title)$/i.test(name)) continue
    const value = fieldValue(markup)
    if (value !== '') classFields[canonicalFieldName(name)] = known(value, classSource)
  }
  const totalLp = /Total LP to master:\s*(\d+)/i.exec(page.content)
  if (totalLp) classFields['Total LP to master'] = known(Number(totalLp[1]), classSource)
  const statSection = extractSections(page.content).find((section) => section.title === 'Stat Growth')
  const statTable = statSection ? extractTables(statSection.body)[0] : undefined
  if (statTable) {
    const lines = statTable.split('\n')
    const growth = {}
    for (let index = 0; index < lines.length - 1; index += 1) {
      if (!lines[index].trimStart().startsWith('!')) continue
      const label = plainText(lines[index].trimStart().slice(1))
      const next = lines[index + 1].trimStart()
      if (!label || !next.startsWith('|') || /^\|[}+\-]/.test(next)) continue
      const value = fieldValue(next.slice(1))
      if (value !== '') growth[label] = value
    }
    if (Object.keys(growth).length > 0) classFields['Stat growth'] = known(growth, sourceRef(page, `${page.title} > Stat Growth`))
  }
  addCandidate(candidates, {
    kind: 'class',
    name: className,
    fields: classFields,
    sources: [classSource],
    legacy: { wiki: { pages: [{ title: page.title, pageId: page.pageId, revisionId: page.revisionId, revisedAt: page.revisedAt }] } },
  })
  if (command) {
    addCandidate(candidates, {
      kind: 'command',
      name: command,
      fields: {
        Category: known(['Commands'], classSource),
        Class: known(className, classSource),
        Description: unknown('The class page names this command but does not provide a separate command summary', classSource),
      },
      sources: [classSource],
      legacy: { wiki: { pages: [{ title: page.title, pageId: page.pageId, revisionId: page.revisionId, revisedAt: page.revisedAt }] } },
    })
  }

  const innateMarkup = classTemplate.parameters['innate passive(s)'] ?? classTemplate.parameters['innate passives']
  const innateText = plainText(innateMarkup ?? '')
  if (innateText) {
    const segments = innateText.split(/\n|;(?=\s*[A-Z][^:]{1,50}:)/).map((value) => value.trim()).filter(Boolean)
    for (const segment of segments) {
      const [suppliedName, ...descriptionParts] = segment.split(':')
      const innateName = normalizedName(suppliedName)
      if (!innateName || innateName.length > 80) {
        issues.push({ page: page.title, issue: 'Unparsed innate passive', value: segment })
        continue
      }
      const description = normalizedName(descriptionParts.join(':'))
      addCandidate(candidates, {
        kind: 'innate',
        name: innateName,
        fields: {
          Category: known(command ? [command] : ['Class innate'], classSource),
          Class: known(className, classSource),
          Description: description ? known(description, classSource) : unknown('The class page names this innate but does not describe it', classSource),
        },
        rawDescription: description,
        sources: [classSource],
        legacy: { wiki: { pages: [{ title: page.title, pageId: page.pageId, revisionId: page.revisionId, revisedAt: page.revisedAt }] } },
      })
    }
  }

  const sections = extractSections(page.content)
  const headingStack = []
  for (const section of sections) {
    headingStack[section.level] = section.title
    headingStack.length = section.level + 1
    for (const tableMarkup of extractTables(section.body)) {
      const table = parseTable(tableMarkup)
      const normalizedHeaders = table.headers.map((header) => header.toLocaleLowerCase())
      if (!normalizedHeaders.includes('name') || !normalizedHeaders.includes('requires')) continue
      const parentHeading = [...headingStack].reverse().find((heading) => heading && heading !== section.title)
      const category = section.title === 'Passives' ? 'Passives' : section.title || parentHeading || command || 'Abilities'
      for (const row of table.rows) {
        const nameCell = cellByHeader(row, /^name$/i)
        const name = nameFromCell(nameCell)
        if (!name) {
          issues.push({ page: page.title, issue: 'Skill table row has no name', value: row.map((cell) => cell.text) })
          continue
        }
        const requires = cellByHeader(row, /^requires$/i)?.text ?? ''
        const cost = cellByHeader(row, /^cost$/i)?.text ?? ''
        const type = cellByHeader(row, /^type$/i)?.text ?? ''
        const description = cellByHeader(row, /^description$/i)?.text ?? ''
        const learningMatch = /(?:^|\n)(\d+)\s*LP\b/i.exec(requires)
        const prerequisites = requires.split('\n').filter((value) => value && !/^\d+\s*LP$/i.test(value) && value !== '-')
        const kind = section.title === 'Passives'
          ? 'passive'
          : /monster magic/i.test(category) || /monster magic/i.test(command)
            ? 'monsterMagic'
            : 'ability'
        const rowSource = sourceRef(page, `${page.title} > Skills > ${category} > ${name}`)
        const fields = {
          Category: known([category], rowSource),
          Class: known(className, rowSource),
          'Learning cost': learningMatch ? known(Number(learningMatch[1]), rowSource) : unknown('No LP cost is documented in the wiki row', rowSource),
          Prerequisites: prerequisites.length > 0 ? known(prerequisites, rowSource) : known([], rowSource),
          Cost: cost ? known(cost, rowSource) : unknown('No resource or PP cost is documented in the wiki row', rowSource),
          ...(type ? { Type: known(type, rowSource) } : {}),
          Description: description ? known(description, rowSource) : unknown('No effect description is documented in the wiki row', rowSource),
        }
        for (const [field, value] of Object.entries(parseResourceCosts(cost))) fields[field] = known(value, rowSource)
        const ppMatch = /(?:^|\n)(\d+)\s*PP\b/i.exec(cost)
        if (ppMatch) fields['PP cost'] = known(Number(ppMatch[1]), rowSource)
        const modeNotes = plainText(withoutTables(section.body)).split('\n').filter((line) => line.toLocaleLowerCase().includes(name.toLocaleLowerCase()) && /vanilla|revert/i.test(line))
        if (modeNotes.length > 0) fields['Vanilla mode notes'] = known(modeNotes, rowSource)
        addCandidate(candidates, {
          kind,
          name,
          fields,
          rawDescription: description,
          ...(ppMatch ? { ppCost: known(Number(ppMatch[1]), rowSource) } : {}),
          sources: [rowSource],
          legacy: { wiki: { pages: [{ title: page.title, pageId: page.pageId, revisionId: page.revisionId, revisedAt: page.revisedAt }] } },
        })
      }
    }
  }
}

function itemTableDetails(page, candidates, issues) {
  const pageCategory = normalizedName(page.title.replace(/\/table$/i, ''))
  const category = pageCategory === page.title ? page.categories.find((value) => value !== 'Items') ?? pageCategory : pageCategory
  for (const tableMarkup of extractTables(page.content)) {
    const table = parseTable(tableMarkup)
    const nameHeader = table.headers.find((header) => /^name$/i.test(header))
    if (!nameHeader) continue
    for (const row of table.rows) {
      const name = nameFromCell(cellByHeader(row, /^name$/i))
      if (!name) {
        issues.push({ page: page.title, issue: 'Item table row has no name', value: row.map((cell) => cell.text) })
        continue
      }
      const rowSource = sourceRef(page, `${page.title} > ${name}`)
      const fields = { Category: known([category], rowSource) }
      for (const cell of row) {
        if (!cell.text || /^#|name$/i.test(cell.header)) continue
        const field = /location|acquisition/i.test(cell.header) ? 'Location' : cell.header
        fields[field] = known(cell.text, rowSource)
      }
      const effect = row.find((cell) => /effect/i.test(cell.header))?.text
      addCandidate(candidates, {
        kind: 'item',
        name,
        fields,
        rawDescription: effect && effect !== '-' ? effect : undefined,
        sources: [rowSource],
        legacy: { wiki: { pages: [{ title: page.title, pageId: page.pageId, revisionId: page.revisionId, revisedAt: page.revisedAt }] } },
      })
    }
  }
}

function craftingDetails(page, candidates) {
  if (page.title !== 'Crafting') return
  for (const section of extractSections(page.content)) {
    if (section.level !== 2 || section.title === 'Craftwork Gear') continue
    const ingredients = [...section.body.matchAll(/^\*\s*(.+)$/gm)].map((match) => plainText(match[1])).filter(Boolean)
    if (ingredients.length === 0) continue
    const source = sourceRef(page, `${page.title} > ${section.title}`)
    addCandidate(candidates, {
      kind: 'recipe',
      name: section.title,
      fields: {
        Category: known(['Crafting'], source),
        Ingredients: known(ingredients, source),
        Description: known(plainText(withoutTables(section.body)), source),
      },
      rawDescription: plainText(withoutTables(section.body)),
      sources: [source],
      legacy: { wiki: { pages: [{ title: page.title, pageId: page.pageId, revisionId: page.revisionId, revisedAt: page.revisedAt }] } },
    })
  }
}

function addExpectedUnknowns(candidate) {
  const expected = EXPECTED_FIELDS[candidate.kind] ?? []
  const source = candidate.sources[0]
  const fields = { ...candidate.fields }
  const missing = []
  for (const field of expected) {
    if (field === 'Description' && candidate.rawDescription) continue
    if (fields[field]) continue
    missing.push(field)
    fields[field] = unknown(`The scraped wiki sources do not document ${field.toLocaleLowerCase()} for this ${candidate.kind}`, source)
  }
  if (missing.length > 0) fields['Missing wiki details'] = known(missing, source)
  return { ...candidate, fields, legacy: { ...candidate.legacy, wiki: { ...candidate.legacy?.wiki, missingFields: missing } } }
}

function collisionSafeIds(candidates) {
  const byId = new Map()
  return candidates.map((candidate) => {
    const existing = byId.get(candidate.id)
    if (!existing || candidateKey(existing.kind, existing.name) === candidateKey(candidate.kind, candidate.name)) {
      byId.set(candidate.id, candidate)
      return candidate
    }
    const suffix = createHash('sha256').update(`${candidate.kind}\0${candidate.name}`).digest('hex').slice(0, 10)
    const updated = { ...candidate, id: `${candidate.id}-${suffix}` }
    byId.set(updated.id, updated)
    return updated
  })
}

function importedPage(page, kind) {
  if (redirectTarget(page.content)) return false
  if (META_PAGE_TITLES.has(page.title)) return false
  if (/\/(?:summary|table)$/i.test(page.title)) return false
  if (page.title.includes('/') && !kind.match(/^(?:class|item|location|monster|status)$/)) return false
  if (COLLECTION_PAGE_TITLES.has(page.title)) return false
  return page.content.trim().length > 0 && (kind !== 'other' || plainText(withoutTables(page.content)).length > 0 || extractTables(page.content).length > 0)
}

function buildCatalog(source) {
  const candidates = new Map()
  const issues = []
  const redirects = []
  const itemCategories = new Set(source.itemCategories)
  const titles = new Set(source.pages.map((page) => normalizedName(page.title).toLocaleLowerCase()))
  const referencedLinks = new Set()

  for (const page of source.pages) {
    const target = redirectTarget(page.content)
    if (target) {
      redirects.push({ title: page.title, target, revisionId: page.revisionId })
      continue
    }
    for (const link of wikiLinks(page.content)) referencedLinks.add(normalizedName(link.target))
    const templates = topLevelTemplates(page.content)
    const kind = primaryKind(page, templates, itemCategories)
    if (importedPage(page, kind)) addCandidate(candidates, genericPageCandidate(page, kind, templates))
    if (kind === 'class') classDetails(page, templates, candidates, issues)
    if (page.title.endsWith('/table') || page.title === 'Consumables') itemTableDetails(page, candidates, issues)
    craftingDetails(page, candidates)
  }

  const aliasTarget = new Map(redirects.map((redirect) => [redirect.title.toLocaleLowerCase(), redirect.target.toLocaleLowerCase()]))
  const redlinks = [...referencedLinks]
    .filter((link) => !titles.has(link.toLocaleLowerCase()) && !aliasTarget.has(link.toLocaleLowerCase()))
    .sort((left, right) => left.localeCompare(right))

  const entities = collisionSafeIds([...candidates.values()]
    .map(addExpectedUnknowns)
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name)))
  const maxRevision = source.pages.reduce((latest, page) => page.revisedAt > latest ? page.revisedAt : latest, '1970-01-01T00:00:00Z')
  const digestInput = stableJson({ entities, redirects, redlinks, issues })
  const contentDigest = createHash('sha256').update(JSON.stringify(digestInput)).digest('hex')
  const entityCounts = Object.fromEntries([...new Set(entities.map((entity) => entity.kind))].sort().map((kind) => [kind, entities.filter((entity) => entity.kind === kind).length]))
  return stableJson({
    schemaVersion: '1.0.0',
    contentDigest,
    maxRevision,
    source: source.site,
    entities,
    coverage: {
      entityCounts,
      issues,
      redlinks,
      redirects,
      importedPages: unique(entities.flatMap((entity) => entity.legacy?.wiki?.pages?.map((page) => page.title) ?? [])).sort((left, right) => left.localeCompare(right)),
      unimportedPages: source.pages.map((page) => page.title).filter((title) => !entities.some((entity) => entity.legacy?.wiki?.pages?.some((page) => page.title === title))).sort((left, right) => left.localeCompare(right)),
    },
  })
}

async function updateStarterDigest(wikiContentDigest) {
  const source = await readFile(STARTER_DATA_PATH, 'utf8')
  const sourceBlock = /export const STARTER_SOURCE_URLS = \{([\s\S]*?)\n\} as const/.exec(source)?.[1]
  if (!sourceBlock) throw new Error('The starter source map could not be parsed')
  const sources = Object.fromEntries([...sourceBlock.matchAll(/^  "([^"]+)": "([^"]+)",$/gm)].map((match) => [match[1], match[2]]))
  const records = [...source.matchAll(/^  \["([^"]+)", "([^"]+)", "([^"]+)", "([^"]+)"\],$/gm)].map((match) => match.slice(1))
  const switchData = JSON.parse(await readFile(SWITCH_DATA_PATH, 'utf8'))
  const digest = createHash('sha256').update(JSON.stringify({ sources, records, wikiContentDigest, switchData })).digest('hex')
  const updated = source.replace(/export const STARTER_CATALOG_CONTENT_DIGEST = "[0-9a-f]{64}"/, `export const STARTER_CATALOG_CONTENT_DIGEST = "${digest}"`)
  if (updated === source && !source.includes(`STARTER_CATALOG_CONTENT_DIGEST = "${digest}"`)) throw new Error('The starter content digest could not be updated')
  await writeFile(STARTER_DATA_PATH, updated)
  return digest
}

async function main() {
  const useCache = process.argv.includes('--cache')
  const source = await loadSource(useCache)
  const catalog = buildCatalog(source)
  await writeFile(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`)
  const starterDigest = await updateStarterDigest(catalog.contentDigest)
  console.log(`Wrote ${catalog.entities.length} entities to ${OUTPUT_PATH}`)
  console.log(`Content digest ${catalog.contentDigest}`)
  console.log(`Starter digest ${starterDigest}`)
  console.log(`Redlinks ${catalog.coverage.redlinks.length}; parser issues ${catalog.coverage.issues.length}`)
}

await main()
