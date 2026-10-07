import type { DefinitionResolver } from './build-mechanics'

export function calculationModResolver(resolve: DefinitionResolver) {
  const issues = new Set<string>()
  const scoped: DefinitionResolver = ref => {
    const definition = resolve(ref)
    const availability = definition?.modAvailability
    if (!availability?.requiredMod || availability.state === 'enabled') return definition
    const state = availability.state === 'unknown' ? 'not recorded as enabled' : availability.state === 'conflicting' ? 'recorded with conflicting settings' : 'disabled'
    issues.add(`${definition!.name}: ${availability.requiredMod} is ${state} in this Game Setup. Enable it and choose a source version to calculate totals. Its effects are not applied.`)
    return undefined
  }
  return { resolve: scoped, issues }
}
