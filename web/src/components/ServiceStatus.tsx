import { useEffect, useRef, useState } from 'react'
import type { Container, ServiceStatus } from '../types'

type Tone = 'ok' | 'warn' | 'off' | 'err'

// 컨테이너 상태를 한 줄 요약으로
export function summarize(st: ServiceStatus | null | undefined): { tone: Tone; label: string } | null {
  if (!st) return null
  if (st.error) return { tone: 'err', label: '상태 확인 실패' }
  const total = st.containers.length
  if (total === 0) return { tone: 'off', label: '컨테이너 없음' }
  const running = st.containers.filter((c) => c.state === 'running').length
  const bad = st.containers.some((c) => c.health === 'unhealthy' || c.state === 'restarting' || c.state === 'dead')
  if (running === 0) return { tone: 'off', label: `중지됨 0/${total}` }
  if (running < total || bad) return { tone: 'warn', label: `${bad ? '이상 있음' : '일부 실행'} ${running}/${total}` }
  return { tone: 'ok', label: `실행 중 ${running}/${total}` }
}

const DOT: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-warn', off: 'bg-faint', err: 'bg-fail' }

export function StatusDot({ status, className = '' }: { status: ServiceStatus | null | undefined; className?: string }) {
  const s = summarize(status)
  if (!s) return null
  return <span className={`w-1.5 h-1.5 rounded-full flex-none ${DOT[s.tone]} ${className}`} title={s.label} aria-label={s.label} />
}

function containerTone(c: Container): Tone {
  if (c.health === 'unhealthy' || c.state === 'restarting' || c.state === 'dead') return 'warn'
  return c.state === 'running' ? 'ok' : 'off'
}

// 헤더에 붙는 상태 칩. 누르면 컨테이너 목록이 펼쳐진다
export function StatusChip({ status }: { status: ServiceStatus | null | undefined }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  const s = summarize(status)
  if (!s || !status) return null
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border border-line text-[12px] text-muted hover:bg-hover whitespace-nowrap">
        <span className={`w-2 h-2 rounded-full ${DOT[s.tone]}`} />{s.label}
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-30 w-[340px] max-w-[calc(100vw-32px)] bg-panel border border-line rounded-xl shadow-xl p-2">
          <p className="px-2 py-1 text-[11px] text-faint">docker compose ps · 15초마다 갱신</p>
          {status.error && <p className="px-2 py-1.5 text-[12px] text-fail break-words">{status.error}</p>}
          {!status.error && status.containers.length === 0 && <p className="px-2 py-1.5 text-[12px] text-muted">만들어진 컨테이너가 없습니다. make up 으로 띄우세요.</p>}
          {status.containers.map((c) => (
            <div key={c.name} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-hover">
              <span className={`w-2 h-2 rounded-full flex-none ${DOT[containerTone(c)]}`} />
              <span className="flex-1 min-w-0">
                <span className="block font-mono text-[12px] truncate">{c.service || c.name}</span>
                <span className="block text-[11px] text-faint truncate">{c.status || c.state}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
