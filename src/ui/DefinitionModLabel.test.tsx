import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HistoricalInnateLearningBadge, ModBadge } from './DefinitionModLabel'
import { LEARNABLE_INNATE_FIELD } from '../catalog/switch'

describe('mod badge', () => {
  it('uses one reusable label for a mod identity', () => {
    const markup = renderToStaticMarkup(<ModBadge name="Learnable Innate Skills"/>)

    expect(markup).toContain('data-mod-badge="Learnable Innate Skills"')
    expect(markup).toContain('Mod: Learnable Innate Skills')
    expect(markup).not.toContain('mod-badge__state')
  })

  it('keeps recorded mod availability explicit', () => {
    const markup = renderToStaticMarkup(<ModBadge name="Doge Shield" state="disabled"/>)

    expect(markup).toContain('data-mod-state="disabled"')
    expect(markup).toContain('Mod: Doge Shield')
    expect(markup).toContain('Disabled')
  })

  it('shows old learnability annotations as history without claiming mod activation', () => {
    const markup = renderToStaticMarkup(<HistoricalInnateLearningBadge record={{ fields: { [LEARNABLE_INNATE_FIELD]: { state: 'known', value: true } } }}/>)
    expect(markup).toContain('Historical learnability note')
    expect(markup).not.toContain('data-mod-badge')
  })
})
