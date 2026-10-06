import { useState } from 'react'
import { Button, InlineNotice } from './components'
import { ErrorMessage } from './ErrorMessage'
import { downloadBytes, formatAppError } from './model'

export function SaveFailureAlert({ error, dirty, saving, onRetry, onExport, onDismiss }: { readonly error: string; readonly dirty: boolean; readonly saving: boolean; readonly onRetry: () => Promise<void>; readonly onExport: () => Promise<Uint8Array>; readonly onDismiss: () => void }) {
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string>()
  const exportRecovery = async () => {
    setExporting(true)
    setExportError(undefined)
    // Use the same retained-transaction export as settings; unsubmitted form fields stay in the form
    try { downloadBytes(await onExport(), 'crykit-recovery.zip', 'application/zip') }
    catch (reason) { setExportError(formatAppError(reason, 'The recovery backup could not be prepared.')) }
    finally { setExporting(false) }
  }
  return <div className="external-update global-save-alert">
    <InlineNotice title={dirty ? 'Local save failed' : 'Change not saved'} tone="danger"><ErrorMessage message={error}/><p>{dirty ? 'Your draft remains open. Retry saving or download a recovery backup.' : 'Resolve the error, then retry the action.'}</p>{dirty && <small>The backup includes retained changes. Fields still in an unsubmitted form stay in that form.</small>}{exportError && <div role="alert"><ErrorMessage message={exportError}/></div>}</InlineNotice>
    <div className="cluster">{dirty && <Button disabled={saving || exporting} icon="refresh" onClick={() => void onRetry().catch(() => undefined)} tone="secondary">{saving ? 'Retrying...' : 'Retry save'}</Button>}<Button disabled={saving || exporting} icon="download" onClick={() => void exportRecovery()} tone="secondary">{exporting ? 'Preparing backup...' : 'Export recovery backup'}</Button>{!dirty && <Button aria-label="Dismiss save alert" onClick={onDismiss} tone="quiet" type="button">Dismiss</Button>}</div>
  </div>
}
