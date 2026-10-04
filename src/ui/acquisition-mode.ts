import { nativeIdentity } from '../domain/native-game'
import type { CatalogEntity } from '../domain/types'

export const ACQUISITION_MODE_QUERY = 'mode'
export const ACQUISITION_MODES = Object.freeze([{ value: 'standard', native: 'base', label: 'Standard' }, { value: 'vanilla', native: 'Vanilla', label: 'Vanilla' }, { value: 'chaos', native: 'Chaos', label: 'Chaos' }])

export function acquisitionMode(entity: CatalogEntity, requested?: string) {
  return ACQUISITION_MODES.find(option => requested === undefined ? option.native === (nativeIdentity(entity)?.mode ?? 'base') : option.value === requested)
}
