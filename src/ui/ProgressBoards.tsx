import { useNavigation, type ProgressPageRoute } from './navigation'

const BOARDS: readonly { readonly label: string; readonly page: ProgressPageRoute }[] = [
  { label: 'Class seals', page: { page: 'progress', view: 'list' } },
  { label: 'Travel & unlocks', page: { page: 'progress', view: 'unlocks' } },
  { label: 'Quintar breeding', page: { page: 'progress', view: 'quintar' } },
]

export function ProgressBoards() {
  const navigation = useNavigation()
  const activeView = navigation.route.page.page === 'progress' && (navigation.route.page.view === 'quintar' || navigation.route.page.view === 'unlocks') ? navigation.route.page.view : 'list'
  return <nav aria-label="Progress guides" className="progress-boards">{BOARDS.map(board => {
    const route = { page: board.page, overlays: [], query: {} }
    return <a aria-current={activeView === board.page.view ? 'page' : undefined} href={navigation.href(route)} key={board.page.view} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigation.navigate(route)
    }}>{board.label}</a>
  })}</nav>
}
