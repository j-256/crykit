// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CURRENT_CATALOG, DEFAULT_CATALOG } from '../catalog/bundled'
import { createBlankLocalData } from '../domain'
import { buildBehavior } from '../domain/build-behavior'
import { selectBuildModRevision } from '../domain/build-mods'
import { CLASS_FIELDS } from '../domain/crystal-edit'
import { composeModCatalog, expandModCatalogs, modCatalogRevision, modModelEntity } from '../domain/mod-layers'
import { createTestLocalData, TEST_GAME_SETUP_REVISION_ID } from '../domain/test-helpers'
import type { CatalogSnapshot, EntityRef, GameSetupRevision, LocalData } from '../domain/types'
import { previewCrystalEdit } from '../interchange/crystal-edit'
import { CommandAbilities } from './CommandAbilities'
import { buildDefinitionOptions, type DefinitionOption } from './definitions'
import { nativeTarget } from './preview-ability-groups'

const localData = createBlankLocalData()
const option = (name: string, catalogs: readonly CatalogSnapshot[] = [CURRENT_CATALOG], data = localData) => buildDefinitionOptions(data, catalogs).find(option => option.kind === 'class' && option.name === name)!

function render(selected: DefinitionOption, catalogs: readonly CatalogSnapshot[] = [CURRENT_CATALOG], gameSetup?: GameSetupRevision, data: LocalData = localData) {
  const container = document.createElement('div')
  container.innerHTML = renderToStaticMarkup(<CommandAbilities catalogs={catalogs} command="Synthetic command" gameSetup={gameSetup} localData={data} option={selected}/>)
  return container
}

const button = (container: HTMLElement, name: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${name} details"]`)!
const preview = (container: HTMLElement, name: string) => button(container, name).parentElement!.querySelector('[role="tooltip"]')!

describe('command ability lists', () => {
  it('shows exact membership with artwork, complete base costs, descriptions, and linked status effects', () => {
    const cleric = option('Cleric')
    const before = JSON.stringify(cleric.record)
    const container = render(cleric)
    expect([...container.querySelectorAll('.ability-preview__trigger > span:nth-child(2)')].map(element => element.textContent)).toEqual(['Cure', 'Curen', 'Curena', 'Raise', 'Return', 'Spark Shine', 'Star Flare', 'Mend', 'Spotlight', 'Blackout'])
    expect(button(container, 'Cure').textContent).toContain('6 MP, 10 CT')
    expect(button(container, 'Cure').querySelector('img')).not.toBeNull()
    expect(preview(container, 'Cure').textContent).toContain('Recovery: 50 + 1.5 Spi')
    expect(preview(container, 'Cure').textContent).toContain('Can use out of combat.')
    expect(preview(container, 'Spotlight').textContent).toContain('Inflict: Spotlight for 2 turns.')
    expect(preview(container, 'Spotlight').textContent).toContain('Take 35% more Fire damage.')
    expect(preview(container, 'Blackout').textContent).toContain('Immune to Fire damage.')
    expect(JSON.stringify(cleric.record)).toBe(before)
  })

  it('preserves unknown membership and costs without falling back to native values', () => {
    const cleric = option('Cleric')
    if (cleric.ref.kind !== 'catalog') throw new Error('The Cleric fixture must be a catalog reference')
    const entity = CURRENT_CATALOG.entities[cleric.ref.entityId]!
    const unknownMembership = { ...CURRENT_CATALOG, entities: { ...CURRENT_CATALOG.entities, [entity.id]: { ...entity, fields: { ...entity.fields, [CLASS_FIELDS.abilities]: { state: 'unknown' as const } } } } }
    const unknown = render(option('Cleric', [unknownMembership]), [unknownMembership])
    expect(unknown.querySelectorAll('.ability-preview__trigger')).toHaveLength(0)
    expect(unknown.textContent).toContain('Ability list unavailable.')
    const cure = CURRENT_CATALOG.entities['base:ability:7']!
    const unknownCost = { ...CURRENT_CATALOG, entities: { ...CURRENT_CATALOG.entities, [cure.id]: { ...cure, fields: { ...cure.fields, Cost: { state: 'unknown' as const, sources: cure.sources } } } } }
    const container = render(option('Cleric', [unknownCost]), [unknownCost])
    expect(button(container, 'Cure').textContent).toContain('Cost: Unknown')
    expect(button(container, 'Cure').textContent).not.toContain('6 MP')
    expect(container.querySelector('[aria-label="Sources for Synthetic command abilities"]')).not.toBeNull()
  })

  it('shows the selected mode membership and the variant ability cost', () => {
    const gameSetup = { ...createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]!, mode: { state: 'known' as const, value: 'Vanilla' } }
    const variant = nativeTarget(CURRENT_CATALOG, 'ability', 388, 'Vanilla')!
    const catalog = { ...CURRENT_CATALOG, entities: { ...CURRENT_CATALOG.entities, [variant.id]: { ...variant, fields: { ...variant.fields, Cost: { state: 'known' as const, value: '99 MP', sources: [{ sourceId: 'synthetic-mode-cost' }] } } } } }
    const container = render(option('Beatsmith', [catalog]), [catalog, DEFAULT_CATALOG], gameSetup)
    expect(button(container, 'Mana Song (Vanilla mode)').textContent).toContain('99 MP')
    expect(button(container, 'Mana Song (Vanilla mode)').textContent).not.toContain('8 MP')
    expect([...container.querySelectorAll('.ability-preview__trigger > span:nth-child(2)')].slice(-2).map(element => element.textContent)).toEqual(['Attack Style (Vanilla mode)', 'Defense Style (Vanilla mode)'])
  })

  it('keeps imported ability identities, text, and costs scoped to the enabled source', async () => {
    const source = (await previewCrystalEdit(new TextEncoder().encode(JSON.stringify({ ID: 'synthetic-command', Title: 'Synthetic command', EditorVersion: 34, Jobs: [{ ID: 9000, Name: 'Synthetic class', AbilityIDs: [9000] }], Abilities: [{ ID: 9000, Name: 'Synthetic spell', Description: 'Synthetic description and additional effect', HPCost: 25, MPCost: 7, APCost: 0, CTCost: 2, CDCost: 0 }] })), 'synthetic.json')).proposed.catalogs[0]!
    const initial = createTestLocalData().gameSetups[TEST_GAME_SETUP_REVISION_ID]!
    const sources = [CURRENT_CATALOG, source]
    const gameSetup = { ...initial, ...selectBuildModRevision(buildBehavior(initial), source, sources), catalogLock: { [CURRENT_CATALOG.id]: modCatalogRevision(initial.id) } }
    const effective = composeModCatalog(gameSetup, sources)!
    const catalogs = expandModCatalogs([...sources, effective])
    const definition = modModelEntity(effective, 'crystal-edit:Jobs:9000')!
    const ref: EntityRef = { kind: 'catalog', catalogId: effective.id, catalogRevisionId: effective.revisionId, entityId: definition.id }
    const selected = { ...option('Cleric'), ref, key: JSON.stringify(ref), name: definition.name, record: definition }
    const container = render(selected, catalogs, gameSetup)
    expect(container.querySelectorAll('.ability-preview__trigger')).toHaveLength(1)
    expect(button(container, 'Synthetic spell').textContent).toContain('25% HP, 7 MP, 2 CT')
    expect(preview(container, 'Synthetic spell').textContent).toContain('Synthetic description and additional effect')
    expect(render(selected, catalogs).textContent).toContain('Ability list unavailable.')
  })
})
