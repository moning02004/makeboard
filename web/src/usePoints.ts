import { useEffect, useState } from 'react'

type Pt = { t: number }
const WINDOW = 3600 // 최근 1시간 (서버가 보관하는 기간과 같다)

/** 차트 기록을 주기적으로 받는다. 처음에만 전부 받고, 이후에는 마지막 점 뒤의 새 점만 받아 붙인다.
 *  탭이 안 보이거나 enabled 가 false 면 받지 않는다. */
export function usePoints<P extends Pt>(key: string | number | null, fetch: (since: number) => Promise<{ points: P[] }>,
  intervalMs: number, enabled = true): P[] {
  const [points, setPoints] = useState<P[]>([])
  useEffect(() => {
    setPoints([])
    if (key == null || !enabled) return
    let alive = true
    let last = 0
    let busy = false
    const load = () => {
      if (document.hidden || busy) return
      busy = true
      fetch(last).then((r) => {
        if (!alive || !r.points.length) return
        last = r.points[r.points.length - 1].t
        setPoints((prev) => [...prev, ...r.points].filter((p) => p.t > last - WINDOW))
      }).catch(() => {}).finally(() => { busy = false })
    }
    load()
    const t = window.setInterval(load, intervalMs)
    const onShow = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onShow)
    return () => { alive = false; window.clearInterval(t); document.removeEventListener('visibilitychange', onShow) }
    // fetch 는 key 로만 바뀌므로 의존성에서 뺀다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, intervalMs, enabled])
  return points
}
