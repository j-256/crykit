import type { SVGProps } from 'react'

export type IconName =
  | 'archive'
  | 'arrow-left'
  | 'book'
  | 'box'
  | 'check'
  | 'character'
  | 'chest'
  | 'chevron-down'
  | 'clock'
  | 'close'
  | 'compare'
  | 'compass'
  | 'crystal'
  | 'download'
  | 'edit'
  | 'egg'
  | 'history'
  | 'info'
  | 'layers'
  | 'menu'
  | 'more'
  | 'plus'
  | 'ring'
  | 'search'
  | 'settings'
  | 'shield'
  | 'spark'
  | 'sword'
  | 'team'
  | 'tome'
  | 'upload'
  | 'user'
  | 'warning'

const paths: Record<IconName, React.ReactNode> = {
  character: <g shapeRendering="crispEdges" stroke="none"><path d="M8 2h8v2h2v8h-2v2h4v7H4v-7h4v-2H6V4h2z" fill="#171e24"/><path d="M8 3h8v3H8zM6 6h3v5H6zM15 6h3v5h-3z" fill="#cf9b68"/><path d="M9 6h6v7H9z" fill="#f3d4a0"/><path d="M10 8h1v2h-1zM14 8h1v2h-1z" fill="#26343d"/><path d="M7 14h10v3h3v4H4v-4h3z" fill="#8284ba"/><path d="M10 14h4v7h-4z" fill="#d4c7e9"/></g>,
  chest: <g shapeRendering="crispEdges" stroke="none"><path d="M5 4h14v2h2v14H3V6h2z" fill="#191e24"/><path d="M5 6h14v5H5zM5 13h14v5H5z" fill="#b18148"/><path d="M5 6h2v12H5zM17 6h2v12h-2zM5 10h14v2H5z" fill="#e3bd71"/><path d="M10 10h4v5h-4z" fill="#f6d88d"/><path d="M11 11h2v2h-2zM7 16h10v2H7z" fill="#765334"/></g>,
  crystal: <g shapeRendering="crispEdges" stroke="none"><path d="M11 1h2v2h2v2h2v3h2v8h-2v3h-2v2h-2v2h-2v-2H9v-2H7v-3H5V8h2V5h2V3h2z" fill="#24567c"/><path d="M11 3h2v2h2v3h2v7h-2v3h-2v3h-2v-3H9v-3H7V8h2V5h2z" fill="#59c7ed"/><path d="M11 4h2v4h-2v8H9V8h2z" fill="#e1fcff"/><path d="M13 8h4v7h-2v3h-2z" fill="#3892c5"/><path d="M11 16h2v5h-2z" fill="#8cecff"/></g>,
  sword: <g shapeRendering="crispEdges" stroke="none"><path d="M16 2h6v6L11 19l-2-2-5 5-3-3 5-5-2-2z" fill="#16212b"/><path d="M17 3h4v4L10 18l-4-4z" fill="#afcfde"/><path d="M17 3h4L8 16l-2-2z" fill="#f0f5e9"/><path d="m6 11 7 7-2 2-7-7zM4 17l3 3-2 2-3-3z" fill="#dcb56d"/><path d="m7 15 2 2-3 3-2-2z" fill="#977052"/></g>,
  tome: <g shapeRendering="crispEdges" stroke="none"><path d="M5 3h15v18H5v-2H3V5h2z" fill="#17232b"/><path d="M5 4h13v13H5z" fill="#ba8360"/><path d="M7 4h2v13H7zM11 7h5v2h-5zM11 11h5v1h-5z" fill="#e9bf7b"/><path d="M5 17h13v3H5z" fill="#ece2c5"/><path d="M5 18h11v1H5z" fill="#b3a997"/></g>,
  archive: <><path d="M4 7h16v13H4z"/><path d="M3 3h18v4H3z"/><path d="M9 11h6"/></>,
  'arrow-left': <><path d="m15 18-6-6 6-6"/><path d="M9 12h10"/></>,
  book: <><path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22z"/><path d="M20 5.5A3.5 3.5 0 0 0 16.5 2H13v17h3.5A3.5 3.5 0 0 1 20 22z"/></>,
  box: <><path d="m4 7 8-4 8 4-8 4z"/><path d="m4 7 8 4 8-4v10l-8 4-8-4z"/><path d="M12 11v10"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  'chevron-down': <path d="m7 10 5 5 5-5"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  close: <><path d="m6 6 12 12"/><path d="m18 6-12 12"/></>,
  compare: <><path d="M8 7h12"/><path d="m16 3 4 4-4 4"/><path d="M16 17H4"/><path d="m8 13-4 4 4 4"/></>,
  compass: <><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></>,
  download: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/></>,
  egg: <><path d="M19 14c0 4.4-3.1 7-7 7s-7-2.6-7-7S8.1 3 12 3s7 6.6 7 11Z"/><path d="m6 12 3 2 3-3 3 3 3-2"/></>,
  history: <><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8"/><path d="M4 3v5h5"/><path d="M12 7v5l3 2"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7h.01"/></>,
  layers: <><path d="m12 3 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 16 9 5 9-5"/></>,
  menu: <><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
  ring: <g shapeRendering="crispEdges" stroke="none"><path d="M8 3h8v2h2v2h2v10h-2v2h-2v2H8v-2H6v-2H4V7h2V5h2z" fill="#825f36"/><path d="M8 5h8v2h2v10h-2v2H8v-2H6V7h2z" fill="#e3bd71"/><path d="M9 8h6v2h2v4h-2v2H9v-2H7v-4h2z" fill="#17232b"/><path d="M8 5h8v2H8zM6 7h2v4H6z" fill="#f6d88d"/><path d="M9 1h6v2h2v3h-2v2H9V6H7V3h2z" data-ring-gem="true" fill="#24567c"/><path d="M10 2h4v1h2v2h-2v2h-4V5H8V3h2z" fill="#59c7ed"/><path d="M10 2h2v3h-2z" fill="#e1fcff"/></g>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  shield: <path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z"/>,
  spark: <path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z"/>,
  team: <><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M14 15.5A5 5 0 0 1 21 20"/></>,
  upload: <><path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>,
  warning: <><path d="M12 3 2.5 20h19z"/><path d="M12 9v5"/><path d="M12 17h.01"/></>,
}

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24" {...props}>
      {paths[name]}
    </svg>
  )
}
