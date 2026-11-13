import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CURRENT_CATALOG } from '../catalog/bundled'
import { MissingSourceNotice } from './MissingSourceNotice'
import type { CatalogRef } from '../domain/types'

it('retains the requested exact revision and offers source recovery despite a different packaged version', () => {
  const reference = { kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: 'v99', entityId: 'base:equipment:3' } as CatalogRef
  const markup = renderToStaticMarkup(<MissingSourceNotice reference={reference} catalogs={[CURRENT_CATALOG]} onImport={() => undefined} onReturn={() => undefined}/>)
  expect(markup).toContain('Exact source unavailable')
  expect(markup).toContain('v99')
  expect(markup).toContain('crystal-project/vanilla')
  expect(markup).toContain('Import source or backup')
  expect(markup).not.toContain('Payload checksum')
})

it('shows an available immutable receipt without treating a missing record as a missing revision', () => {
  const reference = { kind: 'catalog', catalogId: CURRENT_CATALOG.id, catalogRevisionId: CURRENT_CATALOG.revisionId, entityId: 'base:equipment:999999' } as CatalogRef
  const markup = renderToStaticMarkup(<MissingSourceNotice reference={reference} catalogs={[CURRENT_CATALOG]} onImport={() => undefined} onReturn={() => undefined}/>)
  expect(markup).toContain('Source record unavailable')
  expect(markup).toContain(CURRENT_CATALOG.checksum)
})
