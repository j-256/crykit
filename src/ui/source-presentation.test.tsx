import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DefinitionFactsPanel, DefinitionSourcesPanel } from './DefinitionDetailSections'
import { KnowledgeValue } from './KnowledgeValue'

const native = { sourceId: 'game-export:windows:classes', snapshot: 'Windows synthetic; database fingerprint', locator: 'Database/job.dat record 7' }
const wiki = { sourceId: 'https://crystal-project.fandom.com/wiki/Synthetic', locator: 'Community table' }

describe('quiet game export presentation', () => {
  it('keeps native facts quiet and provides their entity attribution behind Sources', () => {
    const facts = renderToStaticMarkup(<DefinitionFactsPanel facts={[['Growth ratings', { state: 'known', value: { HP: 80 }, sources: [native] }]]}/>)
    expect(facts).toContain('Growth ratings')
    expect(facts).toContain('80')
    expect(facts).not.toMatch(/fingerprint|Sources|Source trail|No recorded sources/)
    const sources = renderToStaticMarkup(<DefinitionSourcesPanel sources={[native]}/>)
    expect(sources).toContain('aria-label="Sources"')
    expect(sources).not.toMatch(/fingerprint|Database\/job\.dat|Source trail|No recorded sources/)
  })

  it('keeps conflicting values visible and moves their attribution behind Sources controls', () => {
    const html = renderToStaticMarkup(<><DefinitionSourcesPanel sources={[native, wiki]}/><KnowledgeValue value={{ state: 'conflicting', claims: [{ value: 80, sources: [native] }, { value: 90, sources: [wiki] }] }}/></>)
    expect(html).not.toContain('Community table')
    expect(html).not.toContain('Database/job.dat record 7')
    expect(html).toContain('aria-label="Sources"')
    expect(html).toContain('Sources for claim 1')
    expect(html).toContain('Sources for claim 2')
    expect(html).toContain('80')
    expect(html).toContain('90')
    expect(html).toContain('2 differing source values')
  })
})
