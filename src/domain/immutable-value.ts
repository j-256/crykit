const immutableValues = new WeakSet<object>()

export function deeplyImmutable(value: unknown, visiting = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return true
  if (immutableValues.has(value)) return true
  if (!Object.isFrozen(value) || visiting.has(value)) return false
  visiting.add(value)
  const immutable = Object.values(value).every(child => deeplyImmutable(child, visiting))
  visiting.delete(value)
  if (immutable) immutableValues.add(value)
  return immutable
}
