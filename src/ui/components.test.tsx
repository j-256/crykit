import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BoundedFacetOptions, FacetDropdown, InlineNotice } from './components'

describe('facet option labels', () => {
  const options = [{ value: 'equipment:axe', label: 'Axes', count: 2 }]

  it('renders and selects labels independently of option keys', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<BoundedFacetOptions groupLabel="Synthetic categories" onClear={() => {}} onToggle={() => {}} options={options} searchLabel="Find categories" selected={['equipment:axe']}/>)
    expect(container.querySelector('[aria-label="Axes (2)"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).toContain('Axes')
    expect(container.textContent).not.toContain('equipment:axe')
  })

  it('uses the label for a selected dropdown summary', () => {
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<FacetDropdown allLabel="All categories" groupLabel="Synthetic categories" label="Category" onClear={() => {}} onToggle={() => {}} options={options} searchLabel="Find categories" selected={['equipment:axe']}/>)
    expect(container.querySelector('[aria-label="Category: Axes"]')).not.toBeNull()
    expect(container.textContent).not.toContain('equipment:axe')
  })
})

describe('inline notice', () => {
  it('renders text and block content in a neutral body container', () => {
    const textContainer = document.createElement('div')
    textContainer.innerHTML = renderToStaticMarkup(<InlineNotice title="Plain notice">Plain details</InlineNotice>)
    expect(textContainer.querySelector('.notice__body')?.textContent).toBe('Plain details')
    expect(textContainer.querySelector('.notice__body p')).toBeNull()

    const listContainer = document.createElement('div')
    listContainer.innerHTML = renderToStaticMarkup(<InlineNotice title="Calculation notes"><ul><li>Synthetic issue</li></ul></InlineNotice>)
    expect(listContainer.querySelector('.notice__body > ul > li')?.textContent).toBe('Synthetic issue')
    expect(listContainer.querySelector('.notice__body p')).toBeNull()
  })
})
