import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CATALOG } from '../catalog/bundled'
import { createBlankLocalData } from '../domain'
import { BuildSelectionDetails, BuildSelectionFacts } from './BuildSelectionDetails'
import { buildDefinitionOptions } from './definitions'

const options = buildDefinitionOptions(createBlankLocalData(), [DEFAULT_CATALOG])

describe('selection inspector facts', () => {
  it('shows passive PP once outside the original-source disclosure', () => {
    const passive = options.find(option => option.name === 'HP Boost')!
    const markup = renderToStaticMarkup(<BuildSelectionDetails option={passive}/>)
    const visible = markup.split('<details>')[0]!
    expect(visible.match(/4 PP/g)).toHaveLength(1)
    expect(visible).not.toMatch(/PP: 4|Cost: 4/)
    expect(markup).toContain('Provenance &amp; all reference fields')
  })

  it('shows supported native numbers and explains differing supplemental values', () => {
    const shoes = options.find(option => option.name === 'Acrobat Shoes')!
    const markup = renderToStaticMarkup(<BuildSelectionFacts option={shoes}/>)
    expect(markup).toContain('Dexterity: +14')
    expect(markup).not.toMatch(/Dexterity: \+16|Dexterity \+6/)
    expect(markup).toContain('Supplemental stat values differ')
    const inspector = renderToStaticMarkup(<BuildSelectionDetails option={shoes}/>)
    expect(inspector).toContain('equipment 320')
    expect(inspector.split('<details>')[1]).toMatch(/Dexterity/)
    const comparison = renderToStaticMarkup(<BuildSelectionDetails comparedWith={options.find(option => option.name === 'Beads of Defense')} option={shoes}/>).split('<details>')[0]!
    expect(comparison).toContain('Dexterity: +14')
    expect(comparison).not.toMatch(/Dexterity: \+16|Dexterity \+6/)
  })

  it('shows each passive cost once in its own comparison column', () => {
    const hpBoost = options.find(option => option.name === 'HP Boost')!
    const counter = options.find(option => option.kind === 'passive' && option.name === 'Counter')!
    const visible = renderToStaticMarkup(<BuildSelectionDetails comparedWith={hpBoost} option={counter}/>).split('<details>')[0]!
    const columns = [...visible.matchAll(/<td>(.*?)<\/td>/g)].map(match => match[1]!)
    expect(columns).toHaveLength(2)
    expect(columns[0]).toContain('4 PP')
    expect(columns[1]).toContain('3 PP')
    expect(visible.match(/4 PP/g)).toHaveLength(1)
    expect(visible.match(/3 PP/g)).toHaveLength(1)
    expect(visible).not.toMatch(/PP: [34]|Cost: [34]/)
  })
})
