import { PROGRESS_PAGES, useNavigation } from './navigation'

export function ProgressBoards({ sidebar = false, activeSegment }: { readonly sidebar?: boolean; readonly activeSegment?: typeof PROGRESS_PAGES[number]['segment'] }) {
  const navigation = useNavigation()
  const page = navigation.route.page
  const activeView = activeSegment ? PROGRESS_PAGES.find(board => board.segment === activeSegment)?.page.view : page.page === 'progress' ? PROGRESS_PAGES.find(board => board.page.view === page.view)?.page.view ?? 'list' : undefined
  const links = PROGRESS_PAGES.map(board => {
    const route = { page: board.page, overlays: [], query: {} }
    const link = <a aria-current={activeView === board.page.view ? 'page' : undefined} className={sidebar ? 'nav-sublink' : undefined} href={navigation.href(route)} key={board.page.view} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigation.navigate(route)
    }}>{board.label}</a>
    return sidebar ? <li key={board.page.view}>{link}</li> : link
  })
  return sidebar ? <ul aria-label="Progress pages" className="nav-sublist">{links}</ul> : <nav aria-label="Progress guides" className="progress-boards">{links}</nav>
}
