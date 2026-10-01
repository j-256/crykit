import { Component, type ErrorInfo, type ReactNode } from 'react'
import { exportBackup, loadLocalData } from '../persistence'
import { Button, InlineNotice } from './components'
import { downloadBytes, formatAppError } from './model'

interface State { readonly error?: Error; readonly exporting?: boolean; readonly exportError?: string }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): State { return { error } }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('crykit_render_failure', { name: error.name, componentStack: info.componentStack })
  }

  private exportRecovery = async () => {
    this.setState({ exporting: true, exportError: undefined })
    try {
      await loadLocalData()
      downloadBytes(await exportBackup(), 'crykit-recovery.zip', 'application/zip')
    } catch (reason) {
      this.setState({ exportError: formatAppError(reason, 'The persisted recovery backup could not be prepared.') })
    } finally {
      this.setState({ exporting: false })
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return <main className="error-screen panel"><div className="panel__body stack"><p className="eyebrow">Application recovery</p><h1>This view could not be displayed</h1><InlineNotice title="Your browser data was not cleared" tone="danger">An unexpected rendering error occurred. Export the last persisted planner data before reloading if you need a recovery copy.</InlineNotice>{this.state.exportError && <InlineNotice title="Recovery export failed" tone="danger">{this.state.exportError}</InlineNotice>}<div className="cluster"><Button disabled={this.state.exporting} icon="download" onClick={() => void this.exportRecovery()} tone="secondary">{this.state.exporting ? 'Preparing...' : 'Export persisted planner data'}</Button><Button icon="history" onClick={() => window.location.reload()}>Reload application</Button><Button onClick={() => this.setState({ error: undefined, exportError: undefined })} tone="quiet">Return to the planner</Button></div></div></main>
  }
}
