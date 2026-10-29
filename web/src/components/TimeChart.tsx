import { useEffect, useMemo, useRef, useState } from 'react'

export type Point = { t: number } & Record<string, number | null | undefined>
export type Series = { key: string; label: string; color: string }

const GAP = 45 // 이 초 이상 비면 선을 끊는다 (오프라인 구간)
const H = 140
const PAD = { l: 44, r: 12, t: 10, b: 22 }

export function fmtBytes(n: number | null | undefined, digits = 1): string {
  if (n == null) return '-'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${u[i]}`
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

// 시간에 따른 값. 단일 시리즈는 면을 채우고, 여러 시리즈는 선만 그린다. 마우스를 올리면 그 시각의 값을 보여준다.
export function TimeChart({ points, series, unit, title, fixedMax, minMax }: {
  points: Point[]; series: Series[]; unit: 'pct' | 'rate' | 'bytes'; title: string
  // fixedMax: 세로축 위쪽 끝을 고정 (디스크·메모리 사용률은 100). minMax: 자동으로 늘리되 이보다 작게는 줄이지 않는다
  fixedMax?: number; minMax?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(480)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fmt = (v: number | null | undefined) => (v == null ? '-' : unit === 'pct' ? `${v < 10 ? v.toFixed(1) : Math.round(v)}%` : unit === 'bytes' ? fmtBytes(v) : `${fmtBytes(v)}/s`)
  const now = points.length ? points[points.length - 1].t : Date.now() / 1000
  const t0 = now - 3600
  const peak = Math.max(0, ...points.flatMap((p) => series.map((s) => Number(p[s.key] ?? 0))))
  // 고정이 아니면 값에 맞춰 늘린다. % 는 minMax(기본 5%)~100% 사이, 낮은 값이 축을 꽉 채워 보이지 않도록
  const max = fixedMax ?? (unit === 'pct' ? Math.min(100, niceMax(Math.max(minMax ?? 5, peak))) : niceMax(Math.max(minMax ?? 1, peak)))
  const iw = w - PAD.l - PAD.r, ih = H - PAD.t - PAD.b
  const x = (t: number) => PAD.l + ((t - t0) / 3600) * iw
  const y = (v: number) => PAD.t + ih - (Math.min(v, max) / max) * ih

  // 끊긴 구간마다 따로 그린다
  const segments = useMemo(() => {
    const out: Point[][] = []
    let cur: Point[] = []
    for (const p of points) {
      if (p.t < t0) continue
      if (cur.length && p.t - cur[cur.length - 1].t > GAP) { out.push(cur); cur = [] }
      cur.push(p)
    }
    if (cur.length) out.push(cur)
    return out
  }, [points, t0])

  const line = (seg: Point[], key: string) => seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(Number(p[key] ?? 0)).toFixed(1)}`).join('')
  const area = (seg: Point[], key: string) => `${line(seg, key)}L${x(seg[seg.length - 1].t).toFixed(1)},${y(0)}L${x(seg[0].t).toFixed(1)},${y(0)}Z`
  const ticks = [0, max / 2, max]
  const last = points[points.length - 1]
  const hp = hover != null ? points[hover] : null

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    if (!points.length) return
    const r = e.currentTarget.getBoundingClientRect()
    const t = t0 + ((e.clientX - r.left) / r.width) * 3600
    let best = 0
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i
    setHover(Math.abs(points[best].t - t) < 60 ? best : null)
  }

  return (
    <figure className="bg-panel border border-line rounded-2xl p-4 m-0 flex flex-col gap-2 min-w-0">
      <figcaption className="flex items-baseline gap-3 flex-wrap">
        <span className="text-[13px] font-medium">{title}</span>
        {series.length > 1
          ? series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5 text-[12px] text-muted">
              <span className="w-3 h-[2px] rounded" style={{ background: s.color }} />{s.label} <span className="tabular-nums text-fg">{fmt(last?.[s.key])}</span>
            </span>))
          : <span className="text-[12px] text-muted tabular-nums">지금 <span className="text-fg">{fmt(last?.[series[0].key])}</span></span>}
        <span className="ml-auto text-[11px] text-faint">최근 1시간</span>
      </figcaption>
      <div ref={box} className="relative">
        <svg width={w} height={H} role="img" aria-label={`${title}, 최근 1시간. 지금 ${series.map((s) => `${s.label} ${fmt(last?.[s.key])}`).join(', ')}`} className="block">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke="rgb(var(--line))" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize={10} fill="rgb(var(--faint))" className="tabular-nums">
                {unit === 'pct' ? `${v}%` : fmtBytes(v, 0)}
              </text>
            </g>
          ))}
          <text x={PAD.l} y={H - 6} fontSize={10} fill="rgb(var(--faint))">60분 전</text>
          <text x={w - PAD.r} y={H - 6} fontSize={10} textAnchor="end" fill="rgb(var(--faint))">지금</text>
          {segments.map((seg, i) => (
            <g key={i}>
              {series.length === 1 && seg.length > 1 && <path d={area(seg, series[0].key)} fill={series[0].color} opacity={0.12} />}
              {series.map((s) => seg.length > 1
                ? <path key={s.key} d={line(seg, s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                : <circle key={s.key} cx={x(seg[0].t)} cy={y(Number(seg[0][s.key] ?? 0))} r={2} fill={s.color} />)}
            </g>
          ))}
          {hp && (
            <g pointerEvents="none">
              <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={PAD.t + ih} stroke="rgb(var(--edge))" strokeWidth={1} />
              {series.map((s) => <circle key={s.key} cx={x(hp.t)} cy={y(Number(hp[s.key] ?? 0))} r={4} fill={s.color} stroke="rgb(var(--panel))" strokeWidth={2} />)}
            </g>
          )}
          <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
          {!points.length && <text x={PAD.l + iw / 2} y={PAD.t + ih / 2} textAnchor="middle" fontSize={12} fill="rgb(var(--faint))">기록 모으는 중…</text>}
        </svg>
        {hp && (
          <div className="absolute top-1 pointer-events-none bg-panel border border-line rounded-lg shadow-lg px-2.5 py-1.5 text-[12px] whitespace-nowrap"
            style={{ left: Math.min(Math.max(x(hp.t) + 10, 0), w - 150) }}>
            <div className="text-faint tabular-nums">{clock(hp.t)}</div>
            {series.map((s) => (
              <div key={s.key} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: s.color }} />
                {series.length > 1 && <span className="text-muted">{s.label}</span>}
                <span className="tabular-nums">{fmt(hp[s.key])}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  )
}
