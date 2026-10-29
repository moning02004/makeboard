import { useEffect, useRef, useState } from 'react'

// 글자 막대: cpu ▮▮▮······· 1.6%
// ▮ 같은 문자는 글꼴마다 폭이 달라 줄이 어긋나므로, 칸을 직접 그린다 (채움 ▮ / 빈칸 ·)

const CELL = 7 // 칸 폭 5px + 간격 2px

/** fill: 칸 수를 부모 폭에 맞춰 꽉 채운다 */
export function Gauge({ ratio, cells: fixed = 10, hi = false, fill = false }: { ratio: number; cells?: number; hi?: boolean; fill?: boolean }) {
  const box = useRef<HTMLSpanElement>(null)
  const [auto, setAuto] = useState(fixed)
  useEffect(() => {
    const el = box.current
    if (!fill || !el) return
    const ro = new ResizeObserver(([e]) => setAuto(Math.max(4, Math.floor((e.contentRect.width + 2) / CELL))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [fill])
  const cells = fill ? auto : fixed
  const r = Math.max(0, Math.min(1, ratio || 0))
  // 0 이 아니면 적어도 한 칸은 채워서 "조금 쓰고 있음"이 보이게 한다
  const filled = r > 0 ? Math.max(1, Math.round(r * cells)) : 0
  return (
    <span ref={box} className={`${fill ? 'flex w-full justify-between overflow-hidden' : 'inline-flex flex-none'} items-center gap-[2px]`} aria-hidden="true">
      {Array.from({ length: cells }, (_, i) => i < filled
        ? <span key={i} className={`w-[5px] h-[10px] flex-none rounded-[1.5px] ${hi ? 'bg-warn' : 'bg-accent'}`} />
        : <span key={i} className="w-[5px] h-[10px] flex-none grid place-items-center"><span className="w-[2px] h-[2px] rounded-full bg-faint/70" /></span>)}
    </span>
  )
}

/** 한 줄: 라벨 + 글자 막대(남는 폭을 꽉 채움) + 값. valueCh 로 값 칸 폭을 고정해 여러 줄의 막대 길이를 맞춘다 */
export function GaugeRow({ label, ratio, value, hi, valueCh = 4 }: { label: string; ratio: number; value: string; hi?: boolean; valueCh?: number }) {
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] min-w-0" role="img" aria-label={`${label} ${value}`}>
      <span className="text-faint w-[4ch] flex-none">{label}</span>
      <span className="flex-1 min-w-0"><Gauge ratio={ratio} fill hi={hi} /></span>
      <span className="text-right tabular-nums text-muted whitespace-nowrap flex-none" style={{ minWidth: `${valueCh}ch` }}>{value}</span>
    </span>
  )
}
