import { createContext, useContext, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'

interface WorkspaceHeaderSlots {
  readonly active: boolean
  readonly target: HTMLElement | null
  readonly primaryTarget: HTMLElement | null
  readonly setPrimaryTarget: Dispatch<SetStateAction<HTMLElement | null>>
}

export const WorkspaceHeaderContext = createContext<WorkspaceHeaderSlots | null>(null)

export function useWorkspaceHeader() {
  return useContext(WorkspaceHeaderContext)
}

export function WorkspaceHeaderScope({ active, children }: { readonly active: boolean; readonly children: ReactNode }) {
  const workspace = useWorkspaceHeader()
  const [primaryTarget, setPrimaryTarget] = useState<HTMLElement | null>(null)
  const target = workspace?.target
  const slots = useMemo(() => target === undefined ? null : { active, target, primaryTarget, setPrimaryTarget }, [active, target, primaryTarget])
  return <WorkspaceHeaderContext value={slots}>{children}</WorkspaceHeaderContext>
}

export function WorkspacePrimaryAction({ children }: { readonly children: ReactNode }) {
  const workspace = useWorkspaceHeader()
  if (!workspace) return children
  return workspace.primaryTarget ? createPortal(children, workspace.primaryTarget) : null
}
