import type { Ref } from 'react'
import type { BuildValidityReport } from '../domain/build-validity'
import { Button } from './components'
import { Icon } from './icons'
import { BUILD_REVIEW_FIELDS, buildValidityGuidance } from './build-validity-guidance'

export function BuildValidity({ report, hasPrimaryClass = true, onReviewField, onReviewSetup, onUploadMod, fieldLabels, readOnly = false, panelRef }: { readonly report: BuildValidityReport; readonly hasPrimaryClass?: boolean; readonly onReviewField?: (slotId: string) => void; readonly onReviewSetup?: () => void; readonly onUploadMod?: () => void; readonly fieldLabels?: Readonly<Record<string, string>>; readonly readOnly?: boolean; readonly panelRef?: Ref<HTMLElement> }) {
  const emptyDraft = !hasPrimaryClass && report.status === 'valid'
  const title = emptyDraft ? 'Choose a class to start' : report.status === 'valid' ? 'No known loadout conflicts' : report.status === 'invalid' ? 'Build needs changes' : "CryKit can't fully check this loadout"
  const labels: Readonly<Record<string, string>> = { [BUILD_REVIEW_FIELDS.primaryClass]: 'Class', [BUILD_REVIEW_FIELDS.secondaryClass]: 'Sub-command', [BUILD_REVIEW_FIELDS.passives]: 'passives', ...fieldLabels }
  return <section aria-label="Build validity" className="build-validity" data-status={emptyDraft ? 'draft' : report.status} ref={panelRef} tabIndex={-1}>
    <div className="build-validity__summary"><Icon name={emptyDraft ? 'info' : report.status === 'valid' ? 'check' : 'warning'}/><strong>{title}</strong></div>
    {report.status !== 'valid' && <ul className="validation-issues">{report.issues.map(issue => {
      const guidance = buildValidityGuidance(issue, Boolean(onUploadMod))
      return <li key={`${issue.code}:${issue.slotId ?? ''}:${issue.message}`}><div className="build-validity__issue"><span><strong>{issue.status === 'invalid' ? 'Needs attention' : 'Unknown'}:</strong> {issue.message}</span><div className="build-validity__actions">
        {guidance.importSource && onUploadMod && <Button className="build-validity__review" onClick={onUploadMod} tone="secondary" type="button" icon="upload">Upload mod JSON</Button>}
        {onReviewField && guidance.targets.map(target => <Button className="build-validity__review" key={target} onClick={() => onReviewField(target)} tone="secondary" type="button">{readOnly ? 'Inspect' : 'Review'} {labels[target] ?? 'selection'}</Button>)}
        {guidance.reviewSetup && onReviewSetup && <Button className="build-validity__review" onClick={onReviewSetup} tone="secondary" type="button">Review Game Setup</Button>}
      </div></div><p className="build-validity__help">{guidance.message}{readOnly ? ' Save a copy to change selections or rules.' : ''}</p></li>
    })}</ul>}
  </section>
}
