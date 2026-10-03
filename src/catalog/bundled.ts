import { STARTER_CATALOG } from './starter'
import { assembleBundledCatalog } from './bundled-catalog'
import { addNativeBase } from './native-game'
import { assembleCertaintyCatalog } from './certainty-catalog'
import { immutableCatalogSnapshot } from '../interchange/native'

export const BUNDLED_CATALOG = immutableCatalogSnapshot(assembleCertaintyCatalog(addNativeBase(assembleBundledCatalog(STARTER_CATALOG))))
export const BUNDLED_CATALOGS = [BUNDLED_CATALOG]
export const DEFAULT_CATALOG = BUNDLED_CATALOG
