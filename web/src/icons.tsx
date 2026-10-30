import type { NodeType } from './types'

const PATHS: Record<NodeType, JSX.Element> = {
  compose: <path d="M3 10h18v9H3zM7 10V6h10v4M7.5 14.5h2M14.5 14.5h2" />,
  k8s: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" /><path d="M12 4v5.5M12 14.5V20M4 12h5.5M14.5 12H20" /></>,
  python: <path d="M9 4h5a2 2 0 0 1 2 2v4H9a2 2 0 0 0-2 2v2H6a2 2 0 0 1-2-2V9a5 5 0 0 1 5-5zM15 20h-5a2 2 0 0 1-2-2v-4h7a2 2 0 0 0 2-2v-2h1a2 2 0 0 1 2 2v3a5 5 0 0 1-5 5z" />,
  npm: <path d="M4 7h16v9h-8v2H8v-2H4zM8 10v3M12 10v3M16 10v3" />,
  shell: <path d="M5 7l5 5-5 5M13 17h6" />,
  comp: <><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="12" r="2" /><path d="M8 6h2.5a3.5 3.5 0 0 1 3.5 3.5V12M8 18h2.5a3.5 3.5 0 0 0 3.5-3.5V12h2" /></>,
  preset: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.5a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01" /></>,
}

const ICONS = {
  close: <path d="M6 6l12 12M18 6L6 18" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  shrink: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="M5 12l5 5 9-10" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  up: <path d="M6 14l6-6 6 6" />,
  down: <path d="M6 10l6 6 6-6" />,
  layers: <path d="M4 7l8-4 8 4-8 4zM4 12l8 4 8-4M4 17l8 4 8-4" />,
  refresh: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  logout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
  settings: <><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" /><circle cx="15" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="18" r="2" /></>,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
} as const

export function Svg({ children, size = 18, sw = 1.9, className }: { children: JSX.Element; size?: number; sw?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {children}
    </svg>
  )
}

export const TypeIcon = ({ t, size = 18, sw }: { t: NodeType; size?: number; sw?: number }) => <Svg size={size} sw={sw}>{PATHS[t]}</Svg>
export const Icon = ({ name, size = 18, sw, className }: { name: keyof typeof ICONS; size?: number; sw?: number; className?: string }) =>
  <Svg size={size} sw={sw} className={className}>{ICONS[name]}</Svg>

export const Play = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor" /></svg>
)

export const Star = ({ filled, size = 15 }: { filled?: boolean; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
  </svg>
)

export function Logo() {
  return (
    <span className="w-7 h-7 rounded-lg bg-accent text-onaccent grid place-items-center" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
        <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="12" r="2.5" />
        <path d="M8.5 6H11a4 4 0 0 1 4 4v0a2 2 0 0 0 .5 1.3M8.5 18H11a4 4 0 0 0 4-4" />
      </svg>
    </span>
  )
}
