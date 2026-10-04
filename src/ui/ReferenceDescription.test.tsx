import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { projectAcquisitionGuidance } from '../catalog/acquisition-guidance'
import { nativeDescription } from '../catalog/native-description'
import { nativeFieldFacts } from '../catalog/native-field-facts'
import { nativeMechanic } from '../catalog/native-mechanics'
import type { CatalogEntity } from '../domain/types'
import { ReferenceDescription, referenceNarrativeDescription } from './ReferenceDescription'
import { ReferenceSourceDetails } from './ReferenceSourceDetails'

const entity = (id: string) => DEFAULT_CATALOG.entities[id]!
const sourceDetails = (definition: CatalogEntity) => renderToStaticMarkup(<ReferenceSourceDetails catalog={DEFAULT_CATALOG} entity={definition} guidance={projectAcquisitionGuidance(DEFAULT_CATALOG, definition)} nativeFacts={nativeFieldFacts(DEFAULT_CATALOG, definition)} archivedFacts={definition.fields.Description ? [['Description', definition.fields.Description]] : []} onOpenDefinition={() => undefined}/>)

describe('readable reference descriptions', () => {
  it('shows Dress strategy and directions immediately beside its native effects while retaining attribution separately', () => {
    const dress = entity('base:equipment:134')
    const before = JSON.stringify(dress)
    expect(nativeDescription(dress)?.complete).toBe(true)
    const html = renderToStaticMarkup(<ReferenceDescription entity={dress}/>)
    expect(html).toMatch(/Resistance:\s*\+78/)
    expect(html).toContain('<h3>Description</h3>')
    expect(html).toContain('aria-label="Sources for Description"')
    expect(html).toContain('such as Chemists.')
    expect(html).toContain('before reaching the Chemist crystal')
    expect(html).not.toMatch(/<details|Guide notes|Original source description/)
    const sources = sourceDetails(dress)
    expect(sources).not.toContain('before reaching the Chemist crystal')
    expect(sources).not.toContain('Original source description')
    expect(sources).toContain('https://crystal-project.fandom.com/wiki/Dress?oldid=12426')
    expect(JSON.stringify(dress)).toBe(before)
  })

  it('retains readable acquisition prose when a native route corroborates it without repeating the prose in Sources', () => {
    const salmon = entity('base:item:11')
    const before = JSON.stringify(salmon)
    expect(projectAcquisitionGuidance(DEFAULT_CATALOG, salmon).replacedFields).toContain('Description')
    const html = renderToStaticMarkup(<ReferenceDescription entity={salmon}/>)
    expect(html).toContain('Can be purchased in Delende from the Shady Merchant for')
    expect(html).toContain('aria-label="13 copper"')
    const sources = sourceDetails(salmon)
    expect(sources).not.toContain('Can be purchased in Delende from the Shady Merchant for')
    expect(sources).toContain('Rotten_Salmon')
    expect(sources).toContain('The matching game routes appear under How to obtain.')
    expect(JSON.stringify(salmon)).toBe(before)
  })

  it('keeps corrected historical effects in evidence while displaying the reviewed native description', () => {
    const stew = entity('base:item:132')
    const html = renderToStaticMarkup(<ReferenceDescription entity={stew}/>)
    expect(html).toContain('100% Missing HP')
    expect(html.split('<section')[0]).not.toContain('sources-trigger')
    expect(html).not.toContain('Recovery: 100% HP')
    expect(sourceDetails(stew)).toContain('Recovery: 100% HP')
    const mechanic = entity('base:mechanic:stat:ref-495')
    const replacement = nativeMechanic(mechanic)!
    expect(replacement).toBeDefined()
    expect(renderToStaticMarkup(<ReferenceDescription entity={mechanic}/>)).toContain('Value1 (X) is the native ability ID.')
    expect(renderToStaticMarkup(<ReferenceDescription entity={mechanic}/>)).not.toContain('Increases the AP cost of ability Y by X')
    expect(sourceDetails(mechanic)).toContain('Increases the AP cost of ability Y by X')
  })

  it('keeps exactly corroborated descriptions quiet without promoting changed or unsupported prose', () => {
    const definition = entity('base:mechanic:stat:ref-464')
    const field = definition.fields.Description
    if (field?.state !== 'known') throw new Error('The description fixture must be known')
    expect(renderToStaticMarkup(<ReferenceDescription catalog={DEFAULT_CATALOG} entity={definition}/>)).not.toContain('sources-trigger')
    const changed = { ...definition, rawDescription: 'Synthetic changed description', fields: { ...definition.fields, Description: { ...field, value: 'Synthetic changed description' } } }
    expect(renderToStaticMarkup(<ReferenceDescription catalog={DEFAULT_CATALOG} entity={changed}/>)).toContain('Sources for Description')
    expect(renderToStaticMarkup(<ReferenceDescription catalog={DEFAULT_CATALOG} entity={entity('base:mechanic:stat:ref-501')}/>)).toContain('Sources for Description')
  })

  it('does not repeat authored native prose or add long narrative text to compact descriptions', () => {
    const immortal = entity('base:passive:25')
    expect(nativeDescription(immortal)?.lines).toContain(immortal.rawDescription)
    expect(referenceNarrativeDescription(immortal)).toBeUndefined()
    const html = renderToStaticMarkup(<ReferenceDescription entity={immortal}/>)
    expect(html.match(/Once per battle, automatically revive/g)).toHaveLength(1)
    expect(html).not.toContain('sources-trigger')
    expect(renderToStaticMarkup(<ReferenceDescription compact entity={entity('base:equipment:134')}/>)).not.toContain('before reaching the Chemist crystal')
  })

  it('keeps formatted crafting prose and currency together without repeating its flattened source summary', () => {
    const bow = entity('base:equipment:149')
    const field = bow.fields.Description
    expect(field?.state).toBe('known')
    expect(referenceNarrativeDescription(bow)).toBe(field?.state === 'known' ? field.value : undefined)
    const html = renderToStaticMarkup(<ReferenceDescription entity={bow}/>)
    expect(html).toContain('aria-label="30 silver"')
    expect(html).toContain('Silver Bow x1')
    expect(html).toContain('Gold Ingot x3')
    const sources = sourceDetails(bow)
    expect(sources).not.toContain('Can be crafted in Shoudu Province')
    expect(sources).toContain('Gold_Bow')
  })
})
