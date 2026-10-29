import { useEffect, useState } from 'react'
import type { LogLine, RunInfo, RunStatus, Step } from './types'

export interface RunState {
  id: number
  run: RunInfo | null
  steps: Record<string, Step>
  lines: LogLine[]
  status: RunStatus
  error?: string
}

const MAX_LINES = 5000

type Ev =
  | { type: 'snapshot'; run: RunInfo }
  | ({ type: 'log' } & LogLine)
  | ({ type: 'step' } & Step)
  | { type: 'run'; status: RunStatus; duration: number }
  | { type: 'error'; error: string }

function reduce(s: RunState, ev: Ev): RunState {
  switch (ev.type) {
    case 'snapshot':
      return { ...s, run: ev.run, status: ev.run.status, lines: [], steps: Object.fromEntries(ev.run.steps.map((x) => [x.node, x])) }
    case 'log': {
      const { type: _t, ...line } = ev
      return { ...s, lines: [...s.lines, line] }
    }
    case 'step': {
      const { type: _t, ...step } = ev
      return { ...s, steps: { ...s.steps, [step.node]: { ...s.steps[step.node], ...step } } }
    }
    case 'run':
      return { ...s, status: ev.status, run: s.run ? { ...s.run, status: ev.status, duration: ev.duration } : s.run }
    case 'error':
      return { ...s, error: ev.error, status: 'failed' }
  }
}

/** 모아 둔 이벤트를 한 번에 반영한다. 로그 줄은 배열을 한 번만 새로 만든다. */
function reduceAll(s: RunState, evs: Ev[]): RunState {
  let lines: LogLine[] | null = null
  for (const ev of evs) {
    if (ev.type === 'log') {
      if (!lines) lines = s.lines.slice()
      const { type: _t, ...line } = ev
      lines.push(line)
    } else {
      if (lines) { s = { ...s, lines }; lines = null }
      s = reduce(s, ev)
    }
  }
  if (lines) s = { ...s, lines }
  return s.lines.length > MAX_LINES ? { ...s, lines: s.lines.slice(-MAX_LINES) } : s
}

/** 실행 하나의 로그·상태를 SSE로 받는다. 지난 로그를 먼저 받고 실행 중이면 이어서 받는다.
 *  이벤트마다 화면을 다시 그리면 긴 로그에서 수천 번 렌더링하므로, 한 프레임 동안 모아서 한 번에 반영한다. */
export function useRunStream(runId: number | null, onEnd?: (status: RunStatus, target: string) => void): RunState | null {
  const [state, setState] = useState<RunState | null>(null)
  useEffect(() => {
    if (!runId) { setState(null); return }
    setState({ id: runId, run: null, steps: {}, lines: [], status: 'running' })
    const es = new EventSource(`/api/runs/${runId}/events`)
    let target = ''
    let wasLive = false
    let queue: Ev[] = []
    let cancel: (() => void) | null = null
    const flush = () => {
      cancel?.(); cancel = null
      const evs = queue
      queue = []
      if (evs.length) setState((s) => (s && s.id === runId ? reduceAll(s, evs) : s))
    }
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as Ev
      if (ev.type === 'snapshot') { target = ev.run.target; wasLive = ev.run.status === 'running' }
      queue.push(ev)
      if (ev.type === 'run' || ev.type === 'error') {
        es.close()
        flush()
        if (ev.type === 'run' && wasLive) onEnd?.(ev.status, target)
        return
      }
      // 탭이 안 보이면 requestAnimationFrame 이 멈추므로 타이머로 넘긴다
      if (cancel) return
      if (document.hidden) { const t = window.setTimeout(flush, 250); cancel = () => clearTimeout(t) }
      else { const f = requestAnimationFrame(flush); cancel = () => cancelAnimationFrame(f) }
    }
    return () => { es.close(); cancel?.() }
    // onEnd 는 매 렌더 바뀌므로 의존성에서 뺀다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])
  return state
}
