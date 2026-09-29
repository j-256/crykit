import type { BuildValidityReport } from '../domain/build-validity'
import { Badge } from './components'
import { Icon } from './icons'

export function BuildValidity({ report }: { readonly report: BuildValidityReport }) {
  const title = report.status === 'valid' ? 'No known build issues' : report.status === 'invalid' ? 'Build needs changes' : 'Some build checks are unresolved'
  const tone = report.status === 'valid' ? 'positive' : report.status === 'invalid' ? 'danger' : 'warning'
  return <section aria-label="Build validity" className="build-validity" data-status={report.status}>
    <div className="build-validity__summary"><Icon name={report.status === 'valid' ? 'check' : 'warning'}/><strong>{title}</strong><Badge tone={tone}>{report.status}</Badge></div>
    {report.status !== 'valid' && <ul className="validation-issues">{report.issues.map(issue => <li key={`${issue.code}:${issue.slotId ?? ''}:${issue.message}`}><strong>{issue.status === 'invalid' ? 'Needs attention' : 'Unknown'}:</strong> {issue.message}</li>)}</ul>}
  </section>
}
