// Keep tuple admission independent of local-data writers and planner-journal traversal to avoid a persistence import cycle
export function guestPlannerValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null || Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left), other = Object.keys(right)
  return keys.length === other.length && keys.every(key => Object.hasOwn(right, key) && guestPlannerValuesEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]))
}
