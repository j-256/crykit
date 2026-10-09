import type { Ref } from 'react'
import type { BuildValidityReport } from '../domain/build-validity'
import { Button } from './components'
import { Icon } from './icons'
import { BUILD_REVIEW_FIELDS, buildValidityGuidance } from './build-validity-guidance'

export function BuildValidity({ report, hasPrimaryClass = true, onReviewField, onReviewSetup, onUploadMod, fieldLabels, readOnly = false, panelRef }: { readonly report: BuildValidityReport; readonly hasPrimaryClass?: boolean; readonly onReviewField?: (slotId: string) => void; readonly onReviewSetup?: () => void; readonly onUploadMod?: () => void; readonly fieldLabels?: Readonly<Record<string, string>>; readonly readOnly?: boolean; readonly panelRef?: Ref<HTMLElement> }) {
  const emptyDraft = !hasPrimaryClass && report.status === 'valid'
  const title = emptyDraft ? 'Choose a class to start' : report.status === 'invalid' ? 'Build needs changes' : 'No known loadout conflicts'
  const conflicts = report.issues.filter(issue => issue.status === 'invalid')
  const incomplete = report.issues.filter(issue => issue.status === 'undetermined')
  const sourceDetails = onUploadMod && incomplete.some(issue => buildValidityGuidance(issue, true).importSource)
  const labels: Readonly<Record<string, string>> = { [BUILD_REVIEW_FIELDS.primaryClass]: 'Class', [BUILD_REVIEW_FIELDS.secondaryClass]: 'Sub-command', [BUILD_REVIEW_FIELDS.passives]: 'passives', ...fieldLabels }
  const issueList = (issues: BuildValidityReport['issues']) => <ul className="validation-issues">{issues.map(issue => {
      const guidance = buildValidityGuidance(issue, Boolean(onUploadMod))
      return <li key={`${issue.code}:${issue.slotId ?? ''}:${issue.message}`}><div className="build-validity__issue"><span><strong>{issue.status === 'invalid' ? 'Needs attention' : 'Not checked'}:</strong> {issue.message}</span><div className="build-validity__actions">
        {guidance.importSource && onUploadMod && <Button className="build-validity__review" onClick={onUploadMod} tone="secondary" type="button" icon="upload">Upload mod JSON</Button>}
        {onReviewField && guidance.targets.map(target => <Button className="build-validity__review" key={target} onClick={() => onReviewField(target)} tone="secondary" type="button">{readOnly ? 'Inspect' : 'Review'} {labels[target] ?? 'selection'}</Button>)}
        {guidance.reviewSetup && onReviewSetup && <Button className="build-validity__review" onClick={onReviewSetup} tone="secondary" type="button">Review Game Setup</Button>}
      </div></div><p className="build-validity__help">{guidance.message}{readOnly ? ' Save a copy to change selections or rules.' : ''}</p></li>
    })}</ul>
  return <section aria-label="Build validity" className="build-validity" data-status={emptyDraft ? 'draft' : report.status} ref={panelRef} tabIndex={-1} onFocus={event => {
    // Review actions focus the panel, so reveal its recovery controls before the user continues
    if (event.target === event.currentTarget) for (const details of event.currentTarget.querySelectorAll<HTMLDetailsElement>('.build-validity__details')) details.open = true
  }}>
    {report.status !== 'undetermined' && <div className="build-validity__summary"><Icon name={emptyDraft ? 'info' : report.status === 'valid' ? 'check' : 'warning'}/><strong>{title}</strong></div>}
    {conflicts.length > 0 && issueList(conflicts)}
    {incomplete.length > 0 && <details className="build-validity__details">
      <summary className="build-validity__summary"><Icon name="info"/><span>{sourceDetails ? 'More details with mod JSON' : 'Additional loadout details'}</span><Icon name="chevron-down"/></summary>
      <p className="build-validity__help">{sourceDetails ? 'Import mod JSON to show more selection details and calculations.' : 'These checks need more information about the selections or Game Setup.'}</p>
      {issueList(incomplete)}
    </details>}
  </section>
}
