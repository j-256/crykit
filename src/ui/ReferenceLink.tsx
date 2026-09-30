import type { ReactNode } from 'react'
import type { EntityRef } from '../domain/types'
import { useNavigation, type AppRoute } from './navigation'

export function ReferenceLink({ children, refValue }: { readonly children: ReactNode; readonly refValue: EntityRef }) {
  const navigation = useNavigation()
  const route: AppRoute = { page: { page: 'reference', view: 'detail', ref: refValue }, overlays: [], query: {} }
  return <a href={navigation.href(route)} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    navigation.navigate(route)
  }}>{children}</a>
}
