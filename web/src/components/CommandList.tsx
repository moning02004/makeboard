import { forwardRef, useImperativeHandle, type KeyboardEvent, type ReactNode } from 'react'
import { Play, Star, TypeIcon } from '../icons'
import { argStr, expand, groupsOf, paramsOf, typeOf } from '../model'
import type { Model } from '../types'

export type NodeState = 'queued' | 'running' | 'ok' | 'fail' | 'stopped'

export interface ListHandle {
  /** 그 명령어 카드로 스크롤한다 */
  focus: (n: string) => void
}

interface Props {
  model: Model
  favorites: string[]
  status: Record<string, NodeState>
  selected: string | null
  running: boolean
  panelOpen: boolean
  onSelect: (n: string | null) => void
  onRun: (n: string) => void
  onStop: () => void
  onFav: (n: string) => void
}

const STATE_RING: Record<NodeState, string> = {
  running: 'border-accent',
  ok: 'border-ok',
  fail: 'border-fail',
  queued: 'border-edge',
  stopped: 'border-edge',
}

// 서비스 화면: Makefile 명령어를 ##@ 그룹별 카드로 보여준다. 화면 폭에 맞춰 줄바꿈되고 크기가 줄지 않는다
export const CommandList = forwardRef<ListHandle, Props>(function CommandList(p, ref) {
  const m = p.model
  useImperativeHandle(ref, () => ({
    focus: (n: string) => {
      document.querySelector(`[data-cmd="${CSS.escape(n)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    },
  }), [])

  const card = (n: string, key: string) => {
    const nd = m.nodes[n]
    const t = typeOf(nd)
    const st = p.status[n]
    const fav = p.favorites.includes(n)
    const sel = n === p.selected
    const req = paramsOf(m, n).filter((x) => x.required)
    const comp = nd.kind === 'comp'
    const steps = nd.steps || []
    const sub: ReactNode = comp
      ? (
        <span className="flex flex-wrap items-center gap-1 mt-1">
          {steps.map((x, i) => (
            <span key={x} className="inline-flex items-center gap-1">
              {i > 0 && <span className="text-accent/70 text-[11px]">{nd.mode === 'par' ? '·' : '→'}</span>}
              <span className="font-mono text-[11px] text-fg px-1.5 py-px rounded-full bg-panel">{x}</span>
            </span>
          ))}
        </span>
      )
      : nd.kind === 'preset' ? <span className="font-mono truncate">{nd.target} {argStr(nd.args)}</span>
        : <span className="truncate">{nd.desc || expand(nd.cmds?.[0] || '', m)}</span>
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onSelect(n) } }
    const ring = st === 'running' ? 'border-accent [box-shadow:0_0_0_4px_rgb(var(--accent)/.18)]' : sel ? 'border-accent [box-shadow:0_0_0_4px_rgb(var(--accent)/.14)]' : st ? STATE_RING[st] : nd.kind === 'help' ? 'border-dashed border-edge/60' : comp ? 'border-accent/25' : 'border-line soft-edge'
    return (
      <div key={key} data-cmd={key === n ? n : undefined} role="button" tabIndex={0} aria-label={n} aria-pressed={sel}
        onClick={() => p.onSelect(n)} onKeyDown={onKey}
        className={`group relative ${comp ? 'bg-accentsoft' : 'bg-panel'} rounded-2xl border-[1.5px] ${ring} pl-3 pr-2 py-2.5 flex items-center gap-3 cursor-pointer min-w-0 [box-shadow:var(--card-shadow)] hover:border-edge ty-${t}`}>
        <span className={`tile w-9 h-9 grid place-items-center flex-none relative ${comp ? 'rounded-full !bg-panel' : 'rounded-xl'}`}>
          <TypeIcon t={t} size={17} />
          {st && <span className={`badge-st ${st}`} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="font-mono text-[13px] font-semibold truncate">{n}</span>
            {comp && <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-accent text-onaccent flex-none">{nd.mode === 'par' ? '병렬' : '순차'} {steps.length}단계</span>}
            {st === 'ok' && <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-ok/15 text-ok flex-none">완료 ✓</span>}
            {st === 'fail' && <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-fail/15 text-fail flex-none">실패</span>}
            {st === 'stopped' && <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-hover text-muted flex-none">중지됨</span>}
            {nd.kind === 'help' && <span className="text-[10px] font-semibold px-1.5 rounded-full bg-hover text-muted flex-none">기본</span>}
            {req.length > 0 && <span className="text-[10px] font-mono px-1.5 rounded-full bg-hover text-muted flex-none">{req.map((x) => x.name).join(' ')}=</span>}
          </span>
          {comp ? sub : <span className="flex text-[11.5px] text-faint min-w-0">{sub}</span>}
        </span>
        <span className="flex items-center gap-0.5 flex-none">
          <button type="button" aria-label={fav ? '즐겨찾기 해제' : '즐겨찾기'} title="즐겨찾기"
            onClick={(e) => { e.stopPropagation(); p.onFav(n) }}
            className={`w-8 h-8 grid place-items-center rounded-full hover:bg-hover ${fav ? 'text-warn' : 'text-faint lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100'}`}>
            <Star filled={fav} size={14} />
          </button>
          {st === 'running' ? (
            // 실행 중: 도는 표시, 마우스를 올리면 중지
            <button type="button" aria-label={`make ${n} 중지`} title="중지"
              onClick={(e) => { e.stopPropagation(); p.onStop() }}
              className="group/run h-8 pl-2.5 pr-3 inline-flex items-center gap-1.5 rounded-full bg-accent text-onaccent text-[12px] font-semibold whitespace-nowrap hover:bg-fail">
              <svg className="w-3.5 h-3.5 animate-spin group-hover/run:hidden" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".3" strokeWidth="3" /><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
              <svg className="w-3 h-3 hidden group-hover/run:block" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
              <span className="group-hover/run:hidden">실행 중</span><span className="hidden group-hover/run:inline">중지</span>
            </button>
          ) : st === 'queued' ? (
            <span className="h-8 px-3 inline-flex items-center rounded-full bg-hover text-muted text-[12px] whitespace-nowrap">대기</span>
          ) : (
            <button type="button" aria-label={`make ${n} 실행`} title="실행" disabled={p.running}
              onClick={(e) => { e.stopPropagation(); p.onRun(n) }}
              className={`w-8 h-8 grid place-items-center rounded-full hover:brightness-95 disabled:opacity-40 ${comp ? 'bg-accent text-onaccent' : 'bg-accentsoft text-accent'}`}>
              <Play />
            </button>
          )}
        </span>
      </div>
    )
  }

  const grid = 'grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]'
  const wideGrid = 'grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]'
  const favs = p.favorites.filter((n) => m.nodes[n])
  // 복합 명령어(여러 명령을 묶은 것)는 따로 맨 위에 모은다
  const comps = m.order.filter((n) => m.nodes[n].kind === 'comp')
  return (
    <div className="flex-1 min-w-0 overflow-auto scroll-thin" aria-label="명령어 목록">
      <div className={`px-3 lg:pl-1 pt-1 pb-6 flex flex-col gap-6 ${p.panelOpen ? 'sm:pr-[428px]' : 'lg:pr-3.5'}`}>
        {favs.length > 0 && (
          <section aria-label="즐겨찾기">
            <h3 className="text-[12px] font-semibold text-faint mb-2.5 flex items-center gap-1.5"><span className="text-warn"><Star filled size={12} /></span>즐겨찾기</h3>
            <div className={grid}>{favs.map((n) => card(n, `fav:${n}`))}</div>
          </section>
        )}
        {comps.length > 0 && (
          <section aria-label="복합 명령어">
            <h3 className="text-[12px] font-semibold text-faint mb-2.5">
              <span className="font-mono">## </span>복합 명령어 <span className="font-normal tabular-nums">{comps.length}</span>
              <span className="font-normal"> · 여러 명령어를 차례대로 또는 동시에 실행</span>
            </h3>
            <div className={wideGrid}>{comps.map((n) => card(n, n))}</div>
          </section>
        )}
        {groupsOf(m).map((g) => {
          const names = m.order.filter((n) => (m.nodes[n].group || null) === g && m.nodes[n].kind !== 'comp')
          if (!names.length) return null
          return (
            <section key={g ?? '__none'} aria-label={g ?? '명령어'}>
              <h3 className="text-[12px] font-semibold text-faint mb-2.5">
                <span className="font-mono">## </span>{g ?? '명령어'} <span className="font-normal tabular-nums">{names.length}</span>
              </h3>
              <div className={grid}>{names.map((n) => card(n, n))}</div>
            </section>
          )
        })}
      </div>
    </div>
  )
})
