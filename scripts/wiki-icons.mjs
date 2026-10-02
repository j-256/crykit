import { normalize, switchMappings, wikiUrl } from './wiki-sprites.mjs'

export const ICON_TEMPLATE = 'Template:Icon'
const ELEMENTS = new Set(['earth', 'fire', 'ice', 'thunder', 'water', 'wind'])
const EQUIPMENT_GLYPHS = [
  ['swords', 'SwordAbilityIcon.png'], ['axes', 'AxeAbilityIcon.png'],
  ['daggers', 'DaggerAbilityIcon.png'], ['spears', 'SpearAbilityIcon.png'],
  ['bows', 'BowAbilityIcon.png'], ['rapiers', 'RapierAbilityIcon.png'],
  ['scythes', 'ScytheAbilityIcon.png'], ['staves', 'StaffAbilityIcon.png'],
  ['wands', 'WandAbilityIcon.png'], ['books', 'BookAbilityIcon.png'],
  ['katanas', 'Katana-skill-icon.gif'], ['unarmed', 'UnarmedAbilityIcon.png'],
]

export function iconCandidates(entities, pages, templates) {
  const candidates = EQUIPMENT_GLYPHS.map(([name, file]) => ({ id: `equipment:${name}`, name, title: `File:${file}`, sources: [] }))
  const template = templates.find(page => page.title === ICON_TEMPLATE)
  if (!template) throw new Error('Missing semantic icon template')
  for (const mapping of switchMappings(template)) {
    const kind = ELEMENTS.has(mapping.name) ? 'element' : 'skill'
    candidates.push({ id: `${kind}:${mapping.name}`, name: mapping.name, title: mapping.title, sources: [mapping.source] })
  }
  const byRevision = new Map(pages.map(page => [page.revisionId, page]))
  const commands = new Map()
  for (const entity of entities.filter(entity => entity.kind === 'class')) {
    const command = entity.fields.Command
    if (command?.state !== 'known' || typeof command.value !== 'string') continue
    for (const reference of entity.legacy?.wiki?.pages ?? []) {
      const page = byRevision.get(reference.revisionId)
      if (!page || normalize(page.title) !== normalize(entity.name)) continue
      const heading = [...page.content.matchAll(/^={2,4}\s*\[\[(?:File|Image):([^|\]]+\.(?:png|gif|webp))(?:\|[^\]]*)?\]\]\s*([^=\n]+?)\s*={2,4}\s*$/gmi)].find(match => normalize(match[2]) === normalize(command.value))
      const infoboxFile = /\|command\s*=\s*\[\[(?:File|Image):([^|\]]+\.(?:png|gif|webp))(?:\|[^\]]*)?\]\]/i.exec(page.content)?.[1]
      const file = infoboxFile ?? heading?.[1]
      if (!file) continue
      const id = `command:${normalize(command.value)}`
      const candidate = { id, name: command.value, title: `File:${file}`, sources: [{ title: page.title, revisionId: page.revisionId, url: wikiUrl(page.title, page.revisionId), locator: infoboxFile ? 'Class infobox command image' : `${command.value} section heading` }] }
      const previous = commands.get(id)
      if (previous && normalize(previous.title) !== normalize(candidate.title)) throw new Error(`Conflicting command artwork: ${command.value}`)
      commands.set(id, candidate)
    }
  }
  return [...candidates, ...commands.values()]
}

export function validateIconRegion(region, asset) {
  if (!region) return
  const { x, y, width, height } = region
  if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || x + width > asset.width || y + height > asset.height) throw new Error('Icon region is outside its source image')
}
