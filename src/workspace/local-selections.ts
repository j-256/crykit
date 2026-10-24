import type { LocalData } from '../domain/types'

// Restored records are semantic content; operative choices come only from the selected local profile
export function preserveLocalSelections(next: LocalData, previous: LocalData): LocalData {
  const { selectedPlaythroughId: _selected, planningGameSetupRevisionId: _planning, ...content } = next
  return {
    ...content,
    ...(previous.selectedPlaythroughId && next.playthroughs[previous.selectedPlaythroughId] ? { selectedPlaythroughId: previous.selectedPlaythroughId } : {}),
    ...(previous.planningGameSetupRevisionId && next.gameSetups[previous.planningGameSetupRevisionId] ? { planningGameSetupRevisionId: previous.planningGameSetupRevisionId } : {}),
    playthroughs: Object.fromEntries(Object.entries(next.playthroughs).map(([id, value]) => {
      const { activeScenarioId: _active, ...playthrough } = value
      const selected = previous.playthroughs[id]?.activeScenarioId
      return [id, { ...playthrough, ...(selected && value.scenarios[selected] ? { activeScenarioId: selected } : {}) }]
    })),
  }
}
