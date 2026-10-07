import { useNavigation } from './navigation'
import { MOD_WORKSPACE_PAGES, modEditorView, modWorkspaceRoute } from './mod-workspace'

export function ModWorkspaceLinks() {
  const navigation = useNavigation()
  const page = navigation.route.page
  const active = page.page === 'mods' ? page.view === 'library' ? 'library' : modEditorView(navigation.route.query) : undefined
  return <ul aria-label="Mods pages" className="nav-sublist">{MOD_WORKSPACE_PAGES.map(item => {
    const route = modWorkspaceRoute(item.id, page.page === 'mods' && page.view === 'editor' ? navigation.route.query : {})
    return <li key={item.id}><a className="nav-sublink" href={navigation.href(route)} aria-current={active === item.id ? 'page' : undefined} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigation.navigate(route)
    }}>{item.label}</a></li>
  })}</ul>
}
