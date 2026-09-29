import { useEffect, useRef, useState } from 'react'
import { Button, InlineNotice } from './components'
import { useNavigation, useNavigationBlocker, type AppRoute } from './navigation'

export function useDefinitionDraft(scope: AppRoute) {
  const navigation = useNavigation()
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [exitRequest, setExitRequest] = useState<{ destination?: AppRoute }>()
  const exitRef = useRef<{ destination?: AppRoute } | undefined>(undefined)
  const dirtyRef = useRef(false)
  const busyRef = useRef(false)
  const requestExit = (request?: { destination?: AppRoute }) => { exitRef.current = request; setExitRequest(request) }
  useNavigationBlocker(scope, () => dirtyRef.current || busyRef.current, destination => requestExit({ destination }))
  useEffect(() => {
    if (!dirty && !busy) return
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty, busy])
  const markDirty = () => { dirtyRef.current = true; setDirty(true) }
  const pending = (value: boolean) => { busyRef.current = value; setBusy(value) }
  const complete = (onSaved: () => void, onClose = onSaved) => {
    const request = exitRef.current
    dirtyRef.current = false
    busyRef.current = false
    setDirty(false)
    setBusy(false)
    requestExit(undefined)
    if (request?.destination) navigation.navigate(request.destination)
    else if (request) onClose()
    else onSaved()
  }
  const requestClose = () => {
    if (busyRef.current) return false
    if (!dirtyRef.current) return true
    requestExit({})
    return false
  }
  return { dirty, busy, markDirty, pending, complete, requestClose, exitRequest, keepEditing: () => requestExit(undefined) }
}

export function DefinitionDraftNotice({ draft, formId, onDiscard, saveDisabled = false, title }: { draft: ReturnType<typeof useDefinitionDraft>; formId: string; onDiscard: () => void; saveDisabled?: boolean; title: string }) {
  if (!draft.exitRequest) return null
  return <InlineNotice title={title} tone="warning"><p>Your changes are still here. Save or discard them to continue.</p><div className="cluster"><Button disabled={draft.busy || saveDisabled} form={formId} icon="check" type="submit">Save and continue</Button><Button disabled={draft.busy} onClick={onDiscard} tone="quiet" type="button">Discard and continue</Button><Button disabled={draft.busy} onClick={draft.keepEditing} tone="quiet" type="button">Keep editing</Button></div></InlineNotice>
}
