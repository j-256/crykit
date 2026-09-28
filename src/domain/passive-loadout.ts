import type { CatalogEntityKind, Knowledge, SlotId } from './types'

export const EQUIPPED_PASSIVE_LABEL = 'Equipped passive'

export interface PassivePosition {
  readonly id: SlotId
  readonly kind: 'passive'
  readonly label: string
  readonly acceptedEntityKinds: Knowledge<readonly CatalogEntityKind[]>
}

export function passivePosition(index: number): PassivePosition {
  return {
    id: `equipped-passive-${index + 1}` as SlotId,
    kind: 'passive',
    label: `${EQUIPPED_PASSIVE_LABEL} ${index + 1}`,
    acceptedEntityKinds: { state: 'known', value: ['passive', 'innate'] },
  }
}
