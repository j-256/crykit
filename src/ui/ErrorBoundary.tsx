import { Component, type ReactNode } from 'react'
import { Button, InlineNotice } from './components'
import { downloadBytes, formatAppError } from './model'

interface State { readonly error?: Error; readonly exporting?: boolean; readonly exportError?: string }

export class ErrorBoundary extends Component<{ children: ReactNode; recoveryExport?: () => Promise<Uint8Array>; recoveryDownload?: () => Promise<void> }, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch() {
    console.error('crykit_render_failure', { code: 'RENDER_FAILED' })
  }

  private exportRecovery = async () => {
    this.setState({ exporting: true, exportError: undefined })
    try {
      if (this.props.recoveryDownload) { await this.props.recoveryDownload(); return }
      if (!this.props.recoveryExport) throw new Error('No opened workspace is available for recovery.')
      downloadBytes(await this.props.recoveryExport(), 'crykit-recovery.zip', 'application/zip')
    } catch (reason) {
      this.setState({ exportError: formatAppError(reason, 'The persisted recovery backup could not be prepared.') })
    } finally {
      this.setState({ exporting: false })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return <main className="error-screen panel"><div className="panel__body stack"><p className="eyebrow">Application recovery</p><h1>This view could not be displayed</h1><InlineNotice title="Your browser data was not cleared" tone="danger">Export your last saved workspace, then reload. Open fields that were never saved cannot be recovered here. The backup contains private files; store it privately.</InlineNotice>{this.state.exportError && <InlineNotice title="Recovery export failed" tone="danger">{this.state.exportError}</InlineNotice>}<div className="cluster"><Button disabled={this.state.exporting || (!this.props.recoveryExport && !this.props.recoveryDownload)} icon="download" onClick={() => void this.exportRecovery()} tone="secondary">{this.state.exporting ? 'Preparing...' : 'Export last saved data'}</Button><Button icon="history" onClick={() => window.location.reload()}>Reload app</Button><Button onClick={() => this.setState({ error: undefined, exportError: undefined })} tone="quiet">Return to the planner</Button></div></div></main>
  }
}
