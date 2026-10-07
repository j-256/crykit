import type { BuildValidityReport } from '../domain/build-validity'
import { Button } from './components'
import { Icon } from './icons'

export function BuildValidity({ report, hasPrimaryClass = true, onReviewField, fieldLabels }: { readonly report: BuildValidityReport; readonly hasPrimaryClass?: boolean; readonly onReviewField?: (slotId: string) => void; readonly fieldLabels?: Readonly<Record<string, string>> }) {
  const emptyDraft = !hasPrimaryClass && report.status === 'valid'
  const title = emptyDraft ? 'Choose a class to start' : report.status === 'valid' ? 'No known loadout conflicts' : report.status === 'invalid' ? 'Build needs changes' : "CryKit can't fully check this loadout"
  return <section aria-label="Build validity" className="build-validity" data-status={emptyDraft ? 'draft' : report.status}>
    <div className="build-validity__summary"><Icon name={emptyDraft ? 'info' : report.status === 'valid' ? 'check' : 'warning'}/><strong>{title}</strong></div>
    {report.status !== 'valid' && <ul className="validation-issues">{report.issues.map(issue => <li key={`${issue.code}:${issue.slotId ?? ''}:${issue.message}`}><strong>{issue.status === 'invalid' ? 'Needs attention' : 'Unknown'}:</strong> {issue.message}{issue.slotId && onReviewField && <Button onClick={() => onReviewField(issue.slotId!)} tone="quiet" type="button">Review {fieldLabels?.[issue.slotId] ?? 'selection'}</Button>}</li>)}</ul>}
  </section>
}
