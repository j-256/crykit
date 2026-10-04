import type { BuildValidityReport } from '../domain/build-validity'
import { Badge, Button } from './components'
import { Icon } from './icons'

export function BuildValidity({ report, hasPrimaryClass = true, onReviewField, fieldLabels }: { readonly report: BuildValidityReport; readonly hasPrimaryClass?: boolean; readonly onReviewField?: (slotId: string) => void; readonly fieldLabels?: Readonly<Record<string, string>> }) {
  const emptyDraft = !hasPrimaryClass && report.status === 'valid'
  const title = emptyDraft ? 'Start your Build' : report.status === 'valid' ? 'No known compatibility conflicts' : report.status === 'invalid' ? 'Build needs changes' : 'Some build checks are unresolved'
  const tone = emptyDraft ? 'neutral' : report.status === 'valid' ? 'positive' : report.status === 'invalid' ? 'danger' : 'warning'
  return <section aria-label="Build validity" className="build-validity" data-status={emptyDraft ? 'draft' : report.status}>
    <div className="build-validity__summary"><Icon name={emptyDraft ? 'info' : report.status === 'valid' ? 'check' : 'warning'}/><strong>{title}</strong><Badge tone={tone}>{emptyDraft ? 'draft' : report.status === 'valid' ? 'compatible' : report.status}</Badge></div>
    {!hasPrimaryClass && <p>Choose a class to start planning. You can save an unfinished Build and leave optional equipment slots empty.</p>}
    {report.status !== 'valid' && <ul className="validation-issues">{report.issues.map(issue => <li key={`${issue.code}:${issue.slotId ?? ''}:${issue.message}`}><strong>{issue.status === 'invalid' ? 'Needs attention' : 'Unknown'}:</strong> {issue.message}{issue.slotId && onReviewField && <Button onClick={() => onReviewField(issue.slotId!)} tone="quiet" type="button">Review {fieldLabels?.[issue.slotId] ?? 'selection'}</Button>}</li>)}</ul>}
  </section>
}
