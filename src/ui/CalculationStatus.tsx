import { Button, InlineNotice } from './components'
import type { BuildModRequirement } from '../domain/build-mods'

export function CalculationStatus({ issues, partial = false, onReviewGameSetup, requiredMod }: { readonly issues: readonly string[]; readonly partial?: boolean; readonly onReviewGameSetup?: () => void; readonly requiredMod?: BuildModRequirement }) {
  const [reason = 'A required calculation input is unavailable.', ...additional] = issues
  const details = requiredMod ? issues : additional
  return <InlineNotice title={requiredMod ? `Enable ${requiredMod.name} to calculate stats` : partial ? 'Totals unavailable' : 'Stats unavailable'} tone="warning">
    <p>{requiredMod ? `${requiredMod.selections.join(', ')} requires ${requiredMod.name}. This build has not confirmed it as enabled.` : reason}</p>
    {!requiredMod && <p>{partial ? 'Known values are shown below. Check the missing inputs and loadout to calculate totals.' : 'Check the missing inputs, Game Setup, and loadout to calculate stats.'}</p>}
    {onReviewGameSetup && <Button onClick={onReviewGameSetup} tone="secondary" type="button">{requiredMod ? `Enable ${requiredMod.name}` : 'Review Game Setup'}</Button>}
    {details.length > 0 && <details><summary>More calculation details</summary><ul>{details.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
  </InlineNotice>
}
