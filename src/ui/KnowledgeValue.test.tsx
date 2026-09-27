import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KnowledgeValue } from './KnowledgeValue'
import { definitionIconKey, fieldIconKey, fieldIconKeys } from '../catalog/menu-icons'

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

describe('source-backed field icons', () => {
  it('adds weapon and armor icons while retaining every label and unsupported value', () => {
    const markup = renderToStaticMarkup(<KnowledgeValue field="Weapons" value={{ state: 'known', value: 'Swords, Axes, Daggers, Spears, Unconfirmed tool' }}/>)
    const container = document.createElement('div')
    container.innerHTML = markup
    expect(container.textContent).toBe('Swords, Axes, Daggers, Spears, Unconfirmed tool')
    expect(container.querySelectorAll('img')).toHaveLength(4)
    expect([...container.querySelectorAll('img')].every(img => img.alt === '' && !img.src.startsWith('https:'))).toBe(true)
    expect(fieldIconKey('Armor', 'Heavy helmets')).toBe('equipment:heavy helmets')
    expect(fieldIconKey('Weapons', 'Staff')).toBe('equipment:staves')
  })

  it('does not turn an ability name, arbitrary description, or unknown value into an element', () => {
    expect(fieldIconKey('Name', 'Fire')).toBeUndefined()
    expect(fieldIconKey('Description', 'Swords')).toBeUndefined()
    expect(fieldIconKey('Element', 'Fire')).toBe('element:fire')
    const markup = renderToStaticMarkup(<KnowledgeValue field="Weapons" value={{ state: 'unknown', reason: 'Swords unconfirmed' }}/>)
    expect(markup).not.toContain('<img')
    expect(markup).toContain('Swords unconfirmed')
  })

  it('preserves competing field claims and attributes icons in both alternatives', () => {
    const weapons = { state: 'conflicting' as const, claims: [{ value: 'Swords', sources: [] }, { value: ['Axes', 'Unconfirmed'], sources: [] }] }
    const markup = renderToStaticMarkup(<KnowledgeValue field="Weapons" value={weapons}/>)
    expect(markup).toContain('2 differing source values')
    expect(markup).toContain('Unconfirmed')
    expect(fieldIconKeys({ Weapons: weapons })).toEqual(['equipment:swords', 'equipment:axes'])
  })

  it('uses recorded skill types and schools rather than names to choose skill icons', () => {
    const entity = { name: 'Fire', kind: 'ability' as const, fields: {} }
    expect(definitionIconKey(entity)).toBeUndefined()
    expect(definitionIconKey({ ...entity, fields: { Type: { state: 'known', value: 'Single target Rapier/Sword skill' } } })).toBe('skill:rapier/sword skill')
    expect(definitionIconKey({ ...entity, fields: { Category: { state: 'known', value: ['Abilities', 'Black Magic'] } } })).toBe('skill:black magic')
    expect(definitionIconKey({ ...entity, fields: { Category: { state: 'known', value: ['Black Magic', 'White Magic'] } } })).toBeUndefined()
  })
})
