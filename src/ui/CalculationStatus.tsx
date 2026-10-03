import { Button, InlineNotice } from './components'

export function CalculationStatus({ issues, partial = false, onReviewGameSetup }: { readonly issues: readonly string[]; readonly partial?: boolean; readonly onReviewGameSetup?: () => void }) {
  const [reason = 'A required calculation input is unavailable.', ...additional] = issues
  return <InlineNotice title={partial ? 'Totals unavailable' : 'Stats unavailable'} tone="warning">
    <p>{reason}</p>
    <p>{partial ? 'Available components are shown below. Complete the calculation inputs or resolve the loadout to calculate totals.' : 'Complete the calculation inputs or resolve the Game Setup and loadout to calculate stats.'}</p>
    {onReviewGameSetup && <Button onClick={onReviewGameSetup} tone="secondary" type="button">Review Game Setup</Button>}
    {additional.length > 0 && <details><summary>More calculation details</summary><ul>{additional.map(issue => <li key={issue}>{issue}</li>)}</ul></details>}
  </InlineNotice>
}
