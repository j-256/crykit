import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DefinitionFactsPanel, DefinitionPlanningPanel, DefinitionSourcesPanel } from './DefinitionDetailSections'
import { KnowledgeValue } from './KnowledgeValue'
import { BUNDLED_CATALOGS, DEFAULT_CATALOG } from '../catalog/bundled'
import { CLASS_FIELDS } from '../domain/crystal-edit'
import { nativeFieldFacts } from '../catalog/native-field-facts'
import { corroboratedFact } from '../catalog/source-corroboration'
import { bundledModIdentity } from '../domain/bundled-mods'
import type { Knowledge, NumericContribution } from '../domain/types'

vi.mock('../catalog/bundled', async importOriginal => {
  const actual = await importOriginal<typeof import('../catalog/bundled')>()
  const { SYNTHETIC_MOD_SNAPSHOT } = await import('../catalog/mod.test-helpers')
  const { NATIVE_GAME_DATA } = await import('../catalog/native-game')
  const { buildBundledModEntities } = await import('../domain/bundled-mods')
  const synthetic = { ...actual.CURRENT_CATALOG, id: 'crystal-edit:synthetic-library', revisionId: 'synthetic-source-facts', checksum: 'synthetic-source-facts', entities: buildBundledModEntities(SYNTHETIC_MOD_SNAPSHOT, NATIVE_GAME_DATA.enums), claims: [] }
  return { ...actual, BUNDLED_CATALOGS: [...actual.BUNDLED_CATALOGS, synthetic] }
})

const native = { sourceId: 'native-game:windows:1.6.9', snapshot: 'Windows synthetic; database fingerprint', locator: 'Database/job.dat record 7' }
const external = { sourceId: 'https://example.test/synthetic-import', locator: 'Synthetic external table' }

function planningFixture() {
  const original = (value: number) => ({ state: 'known' as const, value, sources: [external] })
  const verified = (value: number) => ({ state: 'known' as const, value, sources: [native] })
  const receipts = [
    { field: 'Defense', original: original(18), value: verified(19), differs: true, evidence: 'Synthetic defense correction' },
    { field: 'Resistance', original: original(77), value: verified(78), differs: true, evidence: 'Synthetic resistance correction' },
  ]
  const listedContributions = { Defense: { ...original(18), value: { value: 18, unit: 'listed flat value' } }, Resistance: { ...original(77), value: { value: 77, unit: 'listed flat value' } } }
  return { entity: { ...DEFAULT_CATALOG.entities['base:equipment:134']!, listedContributions }, receipts }
}

describe('quiet game export presentation', () => {
  it('keeps known native facts and entity provenance out of ordinary Sources controls', () => {
    const facts = renderToStaticMarkup(<DefinitionFactsPanel facts={[['Growth ratings', { state: 'known', value: { HP: 80 }, sources: [native] }]]}/>)
    expect(facts).toContain('Growth ratings')
    expect(facts).toContain('80')
    expect(facts).not.toMatch(/fingerprint|Sources|Source trail|No source recorded/)
    const sources = renderToStaticMarkup(<DefinitionSourcesPanel anchor={<p>Visible native fact</p>} sources={[native]}><p>Technical provenance</p></DefinitionSourcesPanel>)
    expect(sources).toBe('<p>Visible native fact</p>')
  })

  it('keeps conflicting values visible and moves their attribution behind Sources controls', () => {
    const html = renderToStaticMarkup(<><DefinitionSourcesPanel sources={[native, external]}/><KnowledgeValue value={{ state: 'conflicting', claims: [{ value: 80, sources: [native] }, { value: 90, sources: [external] }] }}/></>)
    expect(html).not.toContain('Synthetic external table')
    expect(html).not.toContain('Database/job.dat record 7')
    expect(html).toContain('aria-label="Sources"')
    expect(html).toContain('Sources for claim 1')
    expect(html).toContain('Sources for claim 2')
    expect(html).toContain('80')
    expect(html).toContain('90')
    expect(html).toContain('2 differing source values')
  })

  it('quiets only an exactly corroborated native class field', () => {
    const entity = DEFAULT_CATALOG.entities['base:job:0']!
    const value = entity.fields[CLASS_FIELDS.equipment]!
    const corroboration = { catalog: DEFAULT_CATALOG, entity }
    expect(corroboratedFact(corroboration, CLASS_FIELDS.equipment, value)).toBe(true)
    const html = renderToStaticMarkup(<DefinitionFactsPanel corroboration={corroboration} facts={[[CLASS_FIELDS.equipment, value]]}/>)
    expect(html).not.toContain(`Sources for ${CLASS_FIELDS.equipment}`)
    const changed = { ...value, state: 'known' as const, value: 'Synthetic changed equipment types' }
    expect(renderToStaticMarkup(<DefinitionFactsPanel corroboration={corroboration} facts={[[CLASS_FIELDS.equipment, changed]]}/>)).toContain(`Sources for ${CLASS_FIELDS.equipment}`)
  })

  it('matches projected native field receipts by the complete field and value', () => {
    const entity = DEFAULT_CATALOG.entities['base:equipment:134']!
    const receipts = nativeFieldFacts(DEFAULT_CATALOG, entity)
    const receipt = receipts.find(fact => fact.field === 'Equipment Type')!
    expect(receipt).toBeDefined()
    if (receipt.value.state !== 'known') throw new Error('The native equipment type fixture must be known')
    const render = (facts: Parameters<typeof DefinitionFactsPanel>[0]['facts'], verifiedNativeFacts = receipts) => renderToStaticMarkup(<DefinitionFactsPanel corroboration={{ catalog: DEFAULT_CATALOG, entity }} facts={facts} verifiedNativeFacts={verifiedNativeFacts}/>)
    expect(render([[receipt.field, receipt.value]])).not.toContain('Sources for Equipment Type')
    expect(render([[receipt.field, { ...receipt.value, value: 'Synthetic wrong equipment type' }]])).toContain('Sources for Equipment Type')
    expect(render([[receipt.field, receipt.value]], [{ ...receipt, field: 'Wrong field' }])).toContain('Sources for Equipment Type')
    expect(render([[receipt.field, { ...receipt.value, sources: [external] }]])).toContain('Sources for Equipment Type')
  })

  it('retains citations for exact bundled mod facts because mod exports are external sources', () => {
    const catalog = BUNDLED_CATALOGS.find(catalog => catalog.id === 'crystal-edit:synthetic-library')!
    const entity = Object.values(catalog.entities).find(entity => bundledModIdentity(entity) && entity.fields['Source mod']?.state === 'known')!
    expect(entity).toBeDefined()
    const value = entity.fields['Source mod']!
    const corroboration = { catalog, entity }
    expect(corroboratedFact(corroboration, 'Source mod', value)).toBe(true)
    const html = renderToStaticMarkup(<DefinitionFactsPanel corroboration={corroboration} facts={[["Source mod", value]]}/>)
    expect(html).toContain('Sources for Source mod')
  })

  it('applies matching planning receipts without changing stored values or provenance', () => {
    const { entity, receipts } = planningFixture()
    const before = JSON.stringify(entity)
    const unverified = renderToStaticMarkup(<DefinitionPlanningPanel definition={entity}/>)
    expect(unverified).toContain('Sources for Defense')
    expect(unverified).toContain('Sources for Resistance')
    const verified = renderToStaticMarkup(<DefinitionPlanningPanel definition={entity} verifiedNativeFacts={receipts}/>)
    for (const [field, value] of [['Defense', 19], ['Resistance', 78]]) {
      expect(verified).toContain(`<dt>${field}</dt>`)
      expect(verified).toContain(`>${value}<`)
      expect(verified).not.toContain(`Sources for ${field}`)
    }
    expect(verified).toContain('listed flat value')
    expect(JSON.stringify(entity)).toBe(before)
  })

  it('keeps altered, uncertain, or differently sourced planning contributions outside native receipts', () => {
    const { entity, receipts } = planningFixture()
    const contribution = entity.listedContributions.Defense!
    if (contribution.state !== 'known') throw new Error('The native defense fixture must be known')
    const changed: readonly Knowledge<NumericContribution>[] = [
      { ...contribution, value: { ...contribution.value, value: -999 } },
      { ...contribution, value: { ...contribution.value, unit: 'percent' } },
      { ...contribution, value: { ...contribution.value, condition: 'Synthetic condition' } },
      { ...contribution, sources: [{ sourceId: 'synthetic-other-source', locator: 'Different contribution source' }] },
      { state: 'unknown', reason: 'Synthetic unknown contribution', sources: contribution.sources },
      { state: 'conflicting', claims: [{ value: contribution.value, sources: contribution.sources ?? [] }, { value: { ...contribution.value, value: 20 }, sources: [native] }] },
    ]
    const expectedValues = ['>-999<', '>percent<', 'Synthetic condition', '>18<', 'Synthetic unknown contribution', '2 differing source values']
    for (const [index, value] of changed.entries()) {
      const definition = { ...entity, listedContributions: { Defense: value } }
      const html = renderToStaticMarkup(<DefinitionPlanningPanel definition={definition} verifiedNativeFacts={receipts}/>)
      expect(html).toContain('Sources for Defense')
      expect(html).toContain(expectedValues[index])
    }
    const wrongField = receipts.map(fact => ({ ...fact, field: `Wrong ${fact.field}` }))
    expect(renderToStaticMarkup(<DefinitionPlanningPanel definition={entity} verifiedNativeFacts={wrongField}/>)).toContain('Sources for Defense')
  })

  it('keeps external child credits accessible without ordinary native citations or missing-source notices', () => {
    for (const sources of [[], [native]]) {
      const panel = DefinitionSourcesPanel({ sources, hasExternalContent: true, label: 'Sources for artwork', children: <a href="https://example.test/artwork">External artwork credit</a> })
      const html = renderToStaticMarkup(panel)
      expect(html).toContain('aria-label="Sources for artwork"')
      const content = renderToStaticMarkup(panel.props.children)
      expect(content).toContain('External artwork credit')
      expect(content).toContain('href="https://example.test/artwork"')
      expect(content).not.toMatch(/No source recorded|Database\/job\.dat|fingerprint/)
    }
  })
})
