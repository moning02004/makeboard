import { useState } from 'react'

type Theme = 'dark' | 'light'

function current(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

// 라이트(기본) ↔ 다크 전환. 고른 값은 이 브라우저에 기억한다
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current)
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    if (next === 'dark') document.documentElement.dataset.theme = 'dark'
    else delete document.documentElement.dataset.theme
    try { localStorage.setItem('mb:theme', next) } catch { /* 저장 불가 환경 */ }
    setTheme(next)
  }
  const label = theme === 'dark' ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기'
  return (
    <button type="button" onClick={toggle} aria-label={label} title={label}
      className="w-8 h-8 grid place-items-center rounded-full text-faint hover:text-fg hover:bg-hover flex-none">
      {theme === 'dark'
        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></svg>}
    </button>
  )
}
