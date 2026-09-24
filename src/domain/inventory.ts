import {
  asTimestamp,
  assertExpectedRevision,
  assertNonnegativeInteger,
  assertPositiveInteger,
  createId,
  DomainError,
  nowTimestamp,
  updateProfile,
} from './core'
import { logicalEntityKey, sameLogicalEntity } from './definitions'
import type {
  EntityRef,
  InventoryEvent,
  InventoryEventId,
  InventoryEventKind,
  InventoryPosition,
  InventoryPositionId,
  Knowledge,
  PossessionState,
  Profile,
  Quantity,
  SourceRef,
  Timestamp,
} from './types'

export interface QuantityBounds {
  readonly lower: number
  readonly upper?: number
}

export function quantityBounds(quantity: Quantity): QuantityBounds {
  switch (quantity.kind) {
    case 'exact':
      return { lower: quantity.value, upper: quantity.value }
    case 'atLeast':
      return { lower: quantity.value }
    case 'unknown':
      return { lower: 0 }
  }
}

function validateQuantity(quantity: Quantity): void {
  if (quantity.kind === 'unknown') {
    return
  }
  assertNonnegativeInteger(quantity.value, 'Quantity')
  if (quantity.kind === 'atLeast' && quantity.value === 0) {
    throw new DomainError('INVALID_INPUT', 'At-least quantity must be at least one')
  }
}

export function normalizePossessionQuantity(
  possession: PossessionState,
  quantity: Quantity,
  protectedQuantity = 0,
): { readonly possession: PossessionState; readonly quantity: Quantity; readonly protectedQuantity: number } {
  validateQuantity(quantity)
  assertNonnegativeInteger(protectedQuantity, 'Protected quantity')

  if (possession === 'notOwned') {
    if (quantity.kind !== 'unknown' && (quantity.kind !== 'exact' || quantity.value !== 0)) {
      throw new DomainError('INVALID_INPUT', 'Not-owned inventory must have an exact zero or unknown quantity')
    }
    if (protectedQuantity !== 0) {
      throw new DomainError('INVALID_INPUT', 'Not-owned inventory cannot protect copies')
    }
    return { possession, quantity: { kind: 'exact', value: 0 }, protectedQuantity: 0 }
  }

  if (quantity.kind === 'exact' && quantity.value === 0) {
    if (possession === 'owned') {
      throw new DomainError('INVALID_INPUT', 'Owned inventory cannot have an exact zero quantity')
    }
    if (protectedQuantity !== 0) {
      throw new DomainError('INVALID_INPUT', 'Zero inventory cannot protect copies')
    }
    return { possession: 'notOwned', quantity, protectedQuantity: 0 }
  }

  if (possession === 'unknown' && quantity.kind !== 'unknown') {
    throw new DomainError('INVALID_INPUT', 'A known positive quantity establishes current ownership')
  }

  let normalized = quantity
  if (possession === 'owned' && quantity.kind === 'unknown') {
    normalized = { kind: 'atLeast', value: 1 }
  }

  if (normalized.kind === 'exact' && protectedQuantity > normalized.value) {
    throw new DomainError('INVALID_INPUT', 'Protected quantity cannot exceed exact stock')
  }

  return {
    possession: normalized.kind === 'unknown' ? possession : 'owned',
    quantity: normalized,
    protectedQuantity,
  }
}

function assertResolvablePersonalRef(profile: Profile, ref: EntityRef): void {
  if (ref.kind === 'personal' && !profile.personalDefinitions[ref.definitionId]) {
    throw new DomainError('MISSING_PERSONAL_DEFINITION', `Personal definition does not exist: ${ref.definitionId}`)
  }
}

export interface ObserveInventoryInput {
  readonly positionId?: InventoryPositionId
  readonly ref: EntityRef
  readonly observedName?: string
  readonly possession: PossessionState
  readonly quantity: Quantity
  readonly favorite?: boolean
  readonly protectedQuantity?: number
  readonly wishlist?: boolean
  readonly note?: string
  readonly observedAt?: Timestamp | string | null
  readonly sources?: readonly SourceRef[]
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function observeInventory(profile: Profile, input: ObserveInventoryInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  assertResolvablePersonalRef(profile, input.ref)
  const matching = Object.values(profile.inventory).find((position) => sameLogicalEntity(profile, position.ref, input.ref))
  const current = input.positionId === undefined ? matching : profile.inventory[input.positionId]
  if (input.positionId !== undefined && !current && matching) {
    throw new DomainError('DUPLICATE_REFERENCE', `Another inventory position already uses ${logicalEntityKey(profile, input.ref)}`)
  }
  if (current && !sameLogicalEntity(profile, current.ref, input.ref)) {
    throw new DomainError('INVALID_INPUT', 'Use linkInventoryPosition to change an inventory reference')
  }
  const id = current?.id ?? input.positionId ?? createId<InventoryPositionId>('inventory')
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const protectedQuantity = input.protectedQuantity ?? current?.protectedQuantity ?? 0
  const normalized = normalizePossessionQuantity(input.possession, input.quantity, protectedQuantity)
  const observedAt = input.observedAt === undefined
    ? current?.observedAt
    : input.observedAt === null
      ? undefined
      : asTimestamp(input.observedAt)
  const position: InventoryPosition = {
    id,
    revision: (current?.revision ?? -1) + 1,
    ref: input.ref,
    possession: normalized.possession,
    quantity: normalized.quantity,
    favorite: input.favorite ?? current?.favorite ?? false,
    protectedQuantity: normalized.protectedQuantity,
    wishlist: input.wishlist ?? current?.wishlist ?? false,
    sources: input.sources ?? current?.sources ?? [],
    updatedAt: at,
    ...(input.observedName ?? current?.observedName
      ? { observedName: input.observedName ?? current?.observedName }
      : {}),
    ...(input.note ?? current?.note ? { note: input.note ?? current?.note } : {}),
    ...(observedAt === undefined ? {} : { observedAt }),
  }
  return updateProfile(
    profile,
    { inventory: { ...profile.inventory, [id]: position } },
    current ? 'inventory.observe.update' : 'inventory.observe.create',
    [`inventory.${id}`],
    at,
  )
}

export interface LinkInventoryPositionInput {
  readonly positionId: InventoryPositionId
  readonly ref: EntityRef
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

export function linkInventoryPosition(profile: Profile, input: LinkInventoryPositionInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  assertResolvablePersonalRef(profile, input.ref)
  const current = profile.inventory[input.positionId]
  if (!current) {
    throw new DomainError('MISSING_INVENTORY_POSITION', `Inventory position does not exist: ${input.positionId}`)
  }
  const duplicate = Object.values(profile.inventory).find(
    (position) => position.id !== current.id && sameLogicalEntity(profile, position.ref, input.ref),
  )
  if (duplicate) {
    throw new DomainError('DUPLICATE_REFERENCE', `Another inventory position already uses ${logicalEntityKey(profile, input.ref)}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const position: InventoryPosition = {
    ...current,
    ref: input.ref,
    revision: current.revision + 1,
    updatedAt: at,
  }
  return updateProfile(
    profile,
    { inventory: { ...profile.inventory, [position.id]: position } },
    'inventory.link',
    [`inventory.${position.id}.ref`],
    at,
  )
}

export interface RecordInventoryEventInput {
  readonly id?: InventoryEventId
  readonly positionId?: InventoryPositionId
  readonly ref: EntityRef
  readonly observedName?: string
  readonly kind: InventoryEventKind
  readonly quantity: Knowledge<number>
  readonly observedAt?: Timestamp | string
  readonly sources?: readonly SourceRef[]
  readonly note?: string
  readonly now?: Timestamp | string
  readonly expectedRevision?: number
}

function validateEventQuantity(quantity: Knowledge<number>): void {
  if (quantity.state === 'known') {
    assertPositiveInteger(quantity.value, 'Event quantity')
  }
  if (quantity.state === 'conflicting') {
    for (const claim of quantity.claims) {
      assertPositiveInteger(claim.value, 'Event quantity claim')
    }
  }
}

export function recordInventoryEvent(profile: Profile, input: RecordInventoryEventInput): Profile {
  assertExpectedRevision(profile, input.expectedRevision)
  assertResolvablePersonalRef(profile, input.ref)
  if (input.positionId) {
    const position = profile.inventory[input.positionId]
    if (!position) {
      throw new DomainError('MISSING_INVENTORY_POSITION', `Inventory position does not exist: ${input.positionId}`)
    }
    if (!sameLogicalEntity(profile, position.ref, input.ref)) {
      throw new DomainError('INVALID_INPUT', 'Inventory event reference does not match its position')
    }
  }
  validateEventQuantity(input.quantity)
  const id = input.id ?? createId<InventoryEventId>('inventoryEvent')
  if (profile.inventoryEvents[id]) {
    throw new DomainError('DUPLICATE_ID', `Inventory event already exists: ${id}`)
  }
  const at = input.now === undefined ? nowTimestamp() : asTimestamp(input.now)
  const event: InventoryEvent = {
    id,
    ref: input.ref,
    kind: input.kind,
    quantity: input.quantity,
    recordedAt: at,
    sources: input.sources ?? [],
    ...(input.positionId === undefined ? {} : { positionId: input.positionId }),
    ...(input.observedName === undefined ? {} : { observedName: input.observedName }),
    ...(input.observedAt === undefined ? {} : { observedAt: asTimestamp(input.observedAt) }),
    ...(input.note === undefined ? {} : { note: input.note }),
  }
  return updateProfile(
    profile,
    { inventoryEvents: { ...profile.inventoryEvents, [id]: event } },
    'inventory.event.record',
    [`inventoryEvents.${id}`],
    at,
  )
}
