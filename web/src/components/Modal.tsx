import { useEffect, type ReactNode } from 'react'

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center p-4 z-50" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-labelledby="mTitle"
        className={`bg-panel rounded-2xl shadow-2xl w-full ${wide ? 'max-w-[720px]' : 'max-w-[560px]'} max-h-[calc(100%-32px)] overflow-auto scroll-thin`}>
        {children}
      </div>
    </div>
  )
}
