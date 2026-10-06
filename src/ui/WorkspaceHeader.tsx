import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'

interface WorkspaceHeaderSlots {
  readonly active: boolean
  readonly target: HTMLElement | null
  readonly primaryTarget: HTMLElement | null
  readonly setPrimaryTarget: Dispatch<SetStateAction<HTMLElement | null>>
  readonly titleTarget: HTMLElement | null
  readonly setTitleTarget: Dispatch<SetStateAction<HTMLElement | null>>
  readonly setUnsavedObject: Dispatch<SetStateAction<boolean>>
}

export const WorkspaceHeaderContext = createContext<WorkspaceHeaderSlots | null>(null)

export function useWorkspaceHeader() {
  return useContext(WorkspaceHeaderContext)
}

export function WorkspaceHeaderScope({ active, children }: { readonly active: boolean; readonly children: ReactNode }) {
  const workspace = useWorkspaceHeader()
  const [primaryTarget, setPrimaryTarget] = useState<HTMLElement | null>(null)
  const [titleTarget, setTitleTarget] = useState<HTMLElement | null>(null)
  const target = workspace?.target
  const setUnsavedObject = workspace?.setUnsavedObject
  const slots = useMemo(() => target === undefined || !setUnsavedObject ? null : { active, target, primaryTarget, setPrimaryTarget, titleTarget, setTitleTarget, setUnsavedObject }, [active, target, primaryTarget, titleTarget, setUnsavedObject])
  return <WorkspaceHeaderContext value={slots}>{children}</WorkspaceHeaderContext>
}

export function WorkspacePrimaryAction({ children }: { readonly children: ReactNode }) {
  const workspace = useWorkspaceHeader()
  if (!workspace) return children
  return workspace.primaryTarget ? createPortal(children, workspace.primaryTarget) : null
}

export function WorkspaceTitle({ children }: { readonly children: ReactNode }) {
  const workspace = useWorkspaceHeader()
  const title = <div data-workspace-title>{children}</div>
  if (!workspace) return title
  // The owning editor keeps its draft while its header is hidden for Reference research
  return workspace.active && workspace.titleTarget ? createPortal(title, workspace.titleTarget) : null
}
