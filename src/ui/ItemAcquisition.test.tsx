import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import type { CatalogEntity } from '../domain/types'
import { ItemAcquisition } from './ItemAcquisition'
import { formatAppRoute, NavigationProvider, type NavigationController } from './navigation'

function render(entity: CatalogEntity, mode?: string) {
  const navigation = { href: formatAppRoute, route: { page: { page: 'reference', view: 'browse' }, query: mode ? { mode: [mode] } : {} } } as unknown as NavigationController
  return renderToStaticMarkup(<NavigationProvider controller={navigation}><ItemAcquisition catalog={CURRENT_CATALOG} entity={entity} onOpenDefinition={() => undefined}/></NavigationProvider>)
}

it('shows supplemental directions once after native acquisition routes with their own attribution', () => {
  const sword = CURRENT_CATALOG.entities['base:equipment:0']!
  const html = render(sword)
  expect(html).toContain('How to obtain')
  expect(html).toContain('Buy')
  expect(html).toContain('Directions')
  expect(html.match(/Nan&#x27;s Knick Knacks/g)).toHaveLength(1)
  expect(html).toContain('Sources for Directions')
  expect(html.indexOf('Buy')).toBeLessThan(html.indexOf('Directions'))
  expect(render(sword, 'vanilla')).not.toContain('Nan&#x27;s Knick Knacks')
  expect(render({ ...sword, name: 'Custom sword' })).not.toContain('Nan&#x27;s Knick Knacks')
})
