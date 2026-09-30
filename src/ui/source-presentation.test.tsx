import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DefinitionFactsPanel, DefinitionSourcesPanel } from './DefinitionDetailSections'
import { KnowledgeValue } from './KnowledgeValue'

const native = { sourceId: 'game-export:windows:classes', snapshot: 'Windows synthetic; database fingerprint', locator: 'Database/job.dat record 7' }
const wiki = { sourceId: 'https://crystal-project.fandom.com/wiki/Synthetic', locator: 'Community table' }

describe('quiet game export presentation', () => {
  it('renders native facts without source controls or an empty source warning', () => {
    const html = renderToStaticMarkup(<><DefinitionFactsPanel facts={[['Growth ratings', { state: 'known', value: { HP: 80 }, sources: [native] }]]}/><DefinitionSourcesPanel sources={[native]}/></>)
    expect(html).toContain('Growth ratings')
    expect(html).toContain('80')
    expect(html).not.toMatch(/fingerprint|Sources|Source trail|No recorded sources/)
  })

  it('keeps supplementary attribution and explicit native conflict evidence', () => {
    const html = renderToStaticMarkup(<><DefinitionSourcesPanel sources={[native, wiki]}/><KnowledgeValue value={{ state: 'conflicting', claims: [{ value: 80, sources: [native] }, { value: 90, sources: [wiki] }] }}/></>)
    expect(html).toContain('Community table')
    expect(html).toContain('Database/job.dat record 7')
    expect(html).toContain('2 differing source values')
  })
})
