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
      const lines = s.lines.length >= MAX_LINES ? [...s.lines.slice(-MAX_LINES + 1), line] : [...s.lines, line]
      return { ...s, lines }
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

/** 실행 하나의 로그·상태를 SSE로 받는다. 지난 로그를 먼저 받고 실행 중이면 이어서 받는다. */
export function useRunStream(runId: number | null, onEnd?: (status: RunStatus, target: string) => void): RunState | null {
  const [state, setState] = useState<RunState | null>(null)
  useEffect(() => {
    if (!runId) { setState(null); return }
    setState({ id: runId, run: null, steps: {}, lines: [], status: 'running' })
    const es = new EventSource(`/api/runs/${runId}/events`)
    let target = ''
    let wasLive = false
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data) as Ev
      if (ev.type === 'snapshot') { target = ev.run.target; wasLive = ev.run.status === 'running' }
      setState((s) => (s && s.id === runId ? reduce(s, ev) : s))
      if (ev.type === 'run') { es.close(); if (wasLive) onEnd?.(ev.status, target) }
      if (ev.type === 'error') es.close()
    }
    return () => es.close()
    // onEnd 는 매 렌더 바뀌므로 의존성에서 뺀다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])
  return state
}
