import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { InlineNotice } from './components'

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
