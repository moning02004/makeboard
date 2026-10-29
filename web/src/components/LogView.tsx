import { useEffect, useRef } from 'react'
import type { LogLine } from '../types'

const time = (ts: number) => new Date(ts * 1000).toTimeString().slice(0, 8)

function cls(l: LogLine): string {
  if (l.stream === 'err') return 'err'
  if (l.stream === 'note') return 'dim' // 중지 같은 안내
  if (l.stream === 'meta') return l.line.startsWith('$') ? 'cmd' : 'okk'
  return ''
}

/** 터미널처럼 시간 | (노드) | 출력 세 칸. 노드 칸은 여러 노드가 함께 도는 실행에서만 보인다. */
export function LogView({ lines, multi, wrap, large, empty }: { lines: LogLine[]; multi: boolean; wrap: boolean; large: boolean; empty: string }) {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [lines.length])
  return (
    <div className={`console flex-[1_0_auto] ${wrap ? 'w-full' : 'w-max min-w-full'}`}>
      <div className={`font-mono ${large ? 'text-[13px]' : 'text-[12px]'} leading-[1.75] p-4`}>
        {lines.length === 0
          ? <p className="text-[rgb(var(--console-dim))]">{empty}</p>
          : (
            <div className={`log ${wrap ? '' : 'nowrap'} ${multi ? '' : 'solo'}`}>
              {lines.map((l) => (
                <div className="ln" key={l.seq}>
                  <span className="tm">{time(l.ts)}</span>
                  <span className="tag">{l.node}</span>
                  <span className={cls(l)}>{l.line}</span>
                </div>
              ))}
            </div>
          )}
        <div ref={end} />
      </div>
    </div>
  )
}
