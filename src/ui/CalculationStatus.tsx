import { Button, InlineNotice } from './components'
import type { BuildModRequirement } from '../domain/build-mods'
import { BATTLE_START_STATUS_LIMITATION } from '../domain/pc-stats'

export function CalculationStatus({ issues, partial = false, onReviewGameSetup, requiredMod }: { readonly issues: readonly string[]; readonly partial?: boolean; readonly onReviewGameSetup?: () => void; readonly requiredMod?: BuildModRequirement }) {
  const [reason = 'A required calculation input is unavailable.', ...additional] = issues
  const details = requiredMod ? issues : additional
  const unsupportedBattleStart = issues.some(issue => issue.includes(BATTLE_START_STATUS_LIMITATION))
  return <InlineNotice title={requiredMod ? `Enable ${requiredMod.name} to calculate stats` : partial ? 'Totals unavailable' : 'Stats unavailable'} tone="warning">
    <p>{requiredMod ? `${requiredMod.selections.join(', ')} requires ${requiredMod.name}. This build has not confirmed it as enabled.` : reason}</p>
    {!requiredMod && <p>{unsupportedBattleStart ? `${partial ? 'Available components are shown below. ' : ''}Battle-state inputs are not available in this preview. For a totals comparison, try an item or passive without automatic battle-start status effects; changing level or growth history will not resolve this limitation.` : partial ? 'Available components are shown below. Complete the calculation inputs or resolve the loadout to calculate totals.' : 'Complete the calculation inputs or resolve the Game Setup and loadout to calculate stats.'}</p>}
    {onReviewGameSetup && (!unsupportedBattleStart || requiredMod) && <Button onClick={onReviewGameSetup} tone="secondary" type="button">{requiredMod ? `Enable ${requiredMod.name}` : 'Review Game Setup'}</Button>}
    {details.length > 0 && <details><summary>More calculation details</summary><ul>{details.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
  </InlineNotice>
}
