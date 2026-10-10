import { Button } from './components'
import { Icon } from './icons'
import './mod-calculation-details.css'

export function ModCalculationDetails({ onUploadMod, onReviewGameSetup, issues, partial = false }: { readonly onUploadMod: () => void; readonly onReviewGameSetup?: () => void; readonly issues: readonly string[]; readonly partial?: boolean }) {
  const reasons = [...new Set(issues)]
  return <div aria-label="Calculations need mod JSON" className="mod-calculation-details" role="group">
    <Icon name="lock"/>
    <div><p>{partial ? 'Import mod JSON to calculate the remaining results. Known values stay visible.' : 'Import mod JSON to calculate results that need the missing definitions.'}</p>
      <Button className="mod-calculation-details__upload" icon="upload" onClick={onUploadMod} tone="secondary" type="button">Upload mod JSON</Button>
      {(reasons.length > 0 || onReviewGameSetup) && <details><summary>Calculation details</summary>{reasons.length > 0 && <ul>{reasons.map(issue => <li key={issue}>{issue}</li>)}</ul>}{onReviewGameSetup && <Button className="mod-calculation-details__upload" onClick={onReviewGameSetup} tone="secondary" type="button">Review Game Setup</Button>}</details>}
    </div>
  </div>
}
