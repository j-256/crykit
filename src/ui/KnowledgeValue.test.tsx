import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KnowledgeValue } from './KnowledgeValue'

describe('source claim presentation', () => {
  it('shows structured values, notes and source revisions while treating markup and unsafe URLs as text', () => {
    const markup = renderToStaticMarkup(<KnowledgeValue value={{ state: 'conflicting', claims: [
      { value: '<script>untrusted()</script>', note: 'Synthetic disputed description', sources: [{ sourceId: 'javascript:untrusted()', locator: 'data:text/html,untrusted' }] },
      { value: [{ shop: 'Synthetic shop', cost: 0, restricted: false }], sources: [{ sourceId: 'https://example.com/wiki?oldid=1', locator: 'Item > Location', snapshot: 'revision 1', applicability: 'Synthetic release' }] },
    ] }}/>)
    const container = document.createElement('div')
    container.innerHTML = markup
    expect(container.querySelectorAll('.knowledge-claim')).toHaveLength(2)
    expect(container.textContent).toContain('<script>untrusted()</script>')
    expect(container.textContent).toContain('Synthetic disputed description')
    expect(container.textContent).toContain('revision 1')
    expect(container.textContent).toContain('Synthetic release')
    expect(container.querySelectorAll('script')).toHaveLength(0)
    expect([...container.querySelectorAll('a')].map((link) => link.href)).toEqual(['https://example.com/wiki?oldid=1'])
    expect([...container.querySelectorAll('td')].map((cell) => cell.textContent)).toEqual(['Synthetic shop', '0', 'false'])
  })
})
