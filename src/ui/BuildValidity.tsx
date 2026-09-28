import type { BuildValidityReport } from '../domain/build-validity'
import { Badge } from './components'
import { Icon } from './icons'

function ppSummary(report: BuildValidityReport): string {
  const subtotal = `${report.pp.knownSubtotal}${report.pp.unresolvedCosts ? ` + ${report.pp.unresolvedCosts} unresolved` : ''}`
  if (report.pp.limit.state === 'known') return `${subtotal} of ${report.pp.limit.value} PP used across passives`
  if (report.pp.limit.state === 'conflicting') return `${subtotal} PP used / conflicting shared limit`
  if (report.pp.limit.state === 'notApplicable') return `${subtotal} PP used / no shared limit applies`
  return `${subtotal} PP used / unknown shared limit`
}

export function BuildValidity({ report }: { readonly report: BuildValidityReport }) {
  const title = report.status === 'valid' ? 'Valid with known rules' : report.status === 'invalid' ? 'Invalid configuration' : 'Validity not fully known'
  const tone = report.status === 'valid' ? 'positive' : report.status === 'invalid' ? 'danger' : 'warning'
  return <section aria-label="Build validity" className="panel build-validity">
    <header className="panel__header"><div><p className="eyebrow">Is this build valid?</p><h3>{title}</h3></div><Badge tone={tone}><Icon name={report.status === 'valid' ? 'check' : 'warning'}/>{report.status}</Badge></header>
    <div className="panel__body stack"><p aria-label="Build PP summary" role="status"><strong>{ppSummary(report)}</strong></p>{report.issues.length > 0 ? <ul className="validation-issues">{report.issues.map(issue => <li key={`${issue.code}:${issue.slotId ?? ''}:${issue.message}`}><strong>{issue.status === 'invalid' ? 'Needs attention' : 'Unknown'}:</strong> {issue.message}</li>)}</ul> : <p>No rule violation was found in the selected class, equipment, passives, or PP total.</p>}<small>This uses only the build's pinned ruleset and source definitions. Character learning, unlocks, inventory, and party conflicts are checked separately.</small></div>
  </section>
}
