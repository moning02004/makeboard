import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'

const Ctx = createContext<(msg: string) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<number>()
  const show = useCallback((m: string) => {
    setMsg(m)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(null), 2800)
  }, [])
  return (
    <Ctx.Provider value={show}>
      {children}
      {msg && (
        <div role="status" className="fixed left-1/2 -translate-x-1/2 bg-fg text-bg text-[13px] px-4 py-2 rounded-full z-[60] shadow-lg max-w-[calc(100%-32px)]"
          style={{ bottom: 'calc(20px + env(safe-area-inset-bottom, 0px))' }}>{msg}</div>
      )}
    </Ctx.Provider>
  )
}

export const useToast = () => useContext(Ctx)
