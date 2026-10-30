import { Icon, Play, Star, TypeIcon } from '../icons'
import { TYPE_LABEL, argStr, expand, helpLines, nodeMake, paramsOf, typeOf, usedBy } from '../model'
import type { Model, RunInfo, ServiceDetail, StepStatus } from '../types'
import type { RunState } from '../useRunStream'
import { LogView } from './LogView'
import { Select } from './Select'

const STEP_LABEL: Record<StepStatus, string> = { queued: '대기', running: '실행 중', ok: '완료', failed: '실패', stopped: '중지', skipped: '건너뜀' }
const RUN_LABEL = { running: '실행 중', ok: '성공', failed: '실패', stopped: '중지' }
const inputCls = 'w-full h-9 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none text-[13px] font-mono'

export interface PanelProps {
  model: Model
  node: string
  service: ServiceDetail
  favorites: string[]
  tab: 'info' | 'log'
  full: boolean
  wrap: boolean
  params: Record<string, string>
  confirm: boolean
  stream: RunState | null
  live: boolean
  runs: RunInfo[]
  running: boolean
  readonly: string | null
  onTab: (t: 'info' | 'log') => void
  onFull: () => void
  onWrap: () => void
  onParam: (name: string, value: string) => void
  onRun: () => void
  onConfirm: () => void
  onCancelConfirm: () => void
  onStop: () => void
  onPreset: () => void
  onEdit: () => void
  onClose: () => void
  onFav: () => void
  onFocus: (n: string) => void
  onViewRun: (id: number) => void
}

export function runLine(m: Model, n: string, vals: Record<string, string>): { line: string; vars: Record<string, string>; missing: string[] } {
  const ps = paramsOf(m, n)
  const vars: Record<string, string> = {}
  const missing: string[] = []
  ps.forEach((p) => {
    const v = (vals[p.name] || '').trim()
    if (v && v !== p.def) vars[p.name] = v
    if (p.required && !v) missing.push(p.name)
  })
  return { line: `make ${n}${Object.keys(vars).length ? ' ' + argStr(vars) : ''}`, vars, missing }
}

export function Panel(p: PanelProps) {
  const { model: m, node: n, service: v } = p
  const nd = m.nodes[n]
  if (!nd) return null
  const t = typeOf(nd), fav = p.favorites.includes(n), params = paramsOf(m, n)
  const { line, missing } = runLine(m, n, p.params)
  const prod = v.server?.environment === 'prod'
  const parents = usedBy(m, n)
  const stepStatus = (s: string) => (p.live ? p.stream?.steps[s]?.status : undefined)
  const previewVals = Object.fromEntries(params.map((x) => [x.name, (p.params[x.name] || '').trim() || x.def || `<${x.name}>`]))

  // 아래에 고정되는 실행 영역 (시안처럼 정보·로그 탭 어디서든 보인다)
  const actions = p.confirm ? (
    <div className="rounded-2xl bg-fail/10 p-4 flex flex-col gap-3">
      <div>
        <p className="text-[13px] font-semibold">운영 서버에서 실행합니다</p>
        <p className="text-[13px] text-muted mt-1"><span className="font-mono">{v.server?.id}:{v.path}</span>에서 아래 명령을 실행할까요?</p>
        <p className="font-mono text-[13px] mt-2">{line}</p>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={p.onConfirm} className="h-9 px-4 rounded-full bg-fail text-onaccent text-[13px] font-semibold hover:brightness-110">실행</button>
        <button type="button" onClick={p.onCancelConfirm} className="h-9 px-4 rounded-full bg-hover text-[13px] hover:brightness-95">취소</button>
      </div>
    </div>
  ) : (
    <div className="flex flex-col gap-2">
      {(!v.server?.online || missing.length > 0) && (
        <p className="text-[12px] text-fail">{!v.server?.online ? '에이전트가 오프라인이라 실행할 수 없습니다' : `${missing.join(', ')} 값을 입력하세요`}</p>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={p.onRun} disabled={p.running || missing.length > 0 || !v.server?.online}
          className="flex-1 h-10 rounded-full bg-accent text-onaccent text-[14px] font-semibold inline-flex items-center justify-center gap-2 hover:brightness-110 disabled:opacity-40">
          <Play /> {nd.kind === 'comp' ? (nd.mode === 'par' ? '병렬 실행' : '순차 실행') : '실행'}
        </button>
        {p.running && <button type="button" onClick={p.onStop} className="h-10 px-4 rounded-full bg-hover text-[13px] hover:brightness-95">중지</button>}
        {nd.kind === 'cmd' && params.length > 0 && !p.readonly && (
          <button type="button" onClick={p.onPreset} className="h-10 px-3.5 rounded-full bg-hover text-[13px] hover:brightness-95" title="지금 입력한 인자로 프리셋 만들기">프리셋</button>
        )}
        {nd.kind !== 'help' && !p.readonly && (
          <button type="button" onClick={p.onEdit} className="h-10 px-4 rounded-full bg-hover text-[13px] hover:brightness-95">편집</button>
        )}
      </div>
    </div>
  )

  const info = (
    <div className="pwrap p-5 flex flex-col gap-6">
      {nd.desc && <p className="text-[14px] text-muted -mt-1">{nd.desc}</p>}

      {params.length > 0 && (
        <section>
          <h4 className="text-[12px] font-medium text-faint mb-2">인자</h4>
          <div className="flex flex-col gap-2">
            {params.map((x) => (
              <label key={x.name} className="grid grid-cols-[96px_1fr] items-center gap-3">
                <span className="font-mono text-[12px] text-muted">{x.name}{x.required && <span className="text-fail"> *</span>}</span>
                <input className={inputCls} value={p.params[x.name] || ''} placeholder={x.def ? `${x.def} (기본값)` : '값 입력'}
                  autoComplete="off" spellCheck={false} onChange={(e) => p.onParam(x.name, e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !missing.length && !p.running) p.onRun() }} />
              </label>
            ))}
          </div>
        </section>
      )}

      {nd.kind !== 'help' && (
        <section>
          <h4 className="text-[12px] font-medium text-faint mb-2">터미널에서</h4>
          <pre className="console rounded-xl px-3.5 py-2.5 text-[12px] font-mono whitespace-pre-wrap break-all"><span className="text-[rgb(var(--console-ok))]">$</span> {line}</pre>
        </section>
      )}

      {nd.kind === 'help' && (
        <section>
          <h4 className="text-[12px] font-medium text-faint mb-2">출력 미리보기</h4>
          <pre className="console rounded-xl p-3.5 text-[12px] leading-relaxed font-mono whitespace-pre overflow-x-auto scroll-thin">
            {helpLines(m).map((l, i) => <div key={i}>{l.map((s, j) => <span key={j} className={s.c || ''}>{s.t}</span>)}{l.length === 1 && !l[0].t ? ' ' : ''}</div>)}
          </pre>
          <p className="text-[12px] text-faint mt-2">타깃 줄 끝의 <span className="font-mono">## 설명</span>과 <span className="font-mono">##@ 그룹</span> 주석으로 만듭니다.</p>
          {nd.virtual && <p className="text-[12px] text-warn mt-1">서버 Makefile에는 아직 없습니다. 다음 저장 때 추가됩니다.</p>}
        </section>
      )}

      {nd.kind === 'cmd' && (
        <section>
          <h4 className="text-[12px] font-medium text-faint mb-2">실행할 명령어</h4>
          <pre className="console rounded-xl p-3.5 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-all">
            {(nd.cmds || []).map((c, i) => <div key={i}><span className="text-[rgb(var(--console-dim))]">$ </span>{expand(c, m, previewVals)}</div>)}
          </pre>
          {nd.deps?.length ? <p className="text-[12px] text-faint mt-2">선행 타깃 <span className="font-mono">{nd.deps.join(', ')}</span>을 make가 먼저 실행합니다.</p> : null}
        </section>
      )}

      {nd.kind === 'preset' && nd.target && m.nodes[nd.target] && (() => {
        const tg = m.nodes[nd.target!], tt = typeOf(tg)
        return (
          <section>
            <h4 className="text-[12px] font-medium text-faint mb-2">고정된 인자로 실행</h4>
            <button type="button" onClick={() => p.onFocus(nd.target!)} className={`w-full flex items-center gap-3 p-2.5 rounded-xl border border-line soft-edge bg-bg hover:bg-hover text-left ty-${tt}`}>
              <span className="tile w-8 h-8 rounded-lg grid place-items-center flex-none"><TypeIcon t={tt} size={16} /></span>
              <span className="min-w-0 flex-1"><span className="block font-mono text-[13px]">{nd.target}</span><span className="block text-[12px] text-faint truncate">{tg.desc || TYPE_LABEL[tt]}</span></span>
            </button>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(nd.args || {}).map(([k, x]) => <span key={k} className="font-mono text-[12px] px-2.5 py-1 rounded-full bg-hover"><span className="text-faint">{k}=</span>{x}</span>)}
            </div>
          </section>
        )
      })()}

      {nd.kind === 'comp' && (
        <section>
          <h4 className="text-[12px] font-medium text-faint mb-2">{nd.mode === 'par' ? '동시에 실행' : '실행 순서'} · {(nd.steps || []).length}개</h4>
          <ol className="flex flex-col gap-1.5">
            {(nd.steps || []).map((s, i) => {
              const st = m.nodes[s], tt = typeOf(st), ss = stepStatus(s)
              return (
                <li key={s}>
                  <button type="button" onClick={() => p.onFocus(s)} className={`w-full flex items-center gap-3 p-2 rounded-xl border border-line soft-edge bg-bg hover:bg-hover text-left ty-${tt}`}>
                    <span className="w-6 h-6 rounded-full bg-accentsoft text-accent grid place-items-center text-[11px] font-semibold tabular-nums flex-none">{nd.mode === 'par' ? '∥' : i + 1}</span>
                    <span className="tile w-8 h-8 rounded-lg grid place-items-center flex-none"><TypeIcon t={tt} size={16} /></span>
                    <span className="min-w-0"><span className="block font-mono text-[13px]">{s}</span><span className="block text-[12px] text-faint truncate">{st.desc || TYPE_LABEL[tt]}</span></span>
                    {ss && <span className={`ml-auto text-[11px] ${ss === 'ok' ? 'text-ok' : ss === 'failed' ? 'text-fail' : 'text-muted'}`}>{STEP_LABEL[ss]}</span>}
                  </button>
                </li>
              )
            })}
          </ol>
        </section>
      )}

      {parents.length > 0 && (
        <section>
          <h4 className="text-[12px] font-medium text-faint mb-2">이 명령어를 쓰는 곳</h4>
          <div className="flex flex-wrap gap-1.5">
            {parents.map((c) => <button key={c} type="button" onClick={() => p.onFocus(c)} className="font-mono text-[12px] px-2.5 py-1 rounded-full bg-hover hover:bg-accentsoft hover:text-accent">{c}</button>)}
          </div>
        </section>
      )}

      {nd.kind !== 'help' && (
        <section>
          <h4 className="text-[12px] font-medium text-faint mb-2">Makefile</h4>
          <pre className="rounded-xl bg-hover p-3.5 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-all text-muted">{(nd.group ? `##@ ${nd.group}\n` : '') + nodeMake(nd)}</pre>
        </section>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
        {nd.group && <><dt className="text-faint">그룹</dt><dd className="text-muted">{nd.group}</dd></>}
        <dt className="text-faint">서버</dt><dd className="font-mono text-muted">{v.server?.id}{prod ? ' · 운영' : ''}</dd>
        <dt className="text-faint">경로</dt><dd className="font-mono text-muted">{v.path}</dd>
      </dl>
    </div>
  )

  const s = p.stream
  const log = (
    <LogView lines={s?.lines || []} multi={!!s?.run?.multi} wrap={p.wrap} large={p.full}
      empty={s?.error || (s ? '로그를 불러오는 중입니다…' : '실행하면 출력이 여기에 표시됩니다.')} />
  )

  return (
    <>
      <div className={`flex items-center gap-3 px-5 pt-5 pb-4 ty-${t}`}>
        <span className={`tile w-11 h-11 rounded-xl grid place-items-center flex-none ${nd.kind === 'comp' ? '!rounded-full' : ''}`}><TypeIcon t={t} size={22} /></span>
        <div className="min-w-0 flex-1">
          <h2 className="font-mono text-[17px] font-medium truncate">{n}</h2>
          <p className="text-[12px] text-faint">{TYPE_LABEL[t]}{nd.kind === 'cmd' ? ` · 명령 ${(nd.cmds || []).length}개` : nd.kind === 'comp' ? ` · ${nd.mode === 'par' ? '병렬 실행' : '순차 실행'}` : ''}</p>
        </div>
        <button type="button" onClick={p.onFav} aria-label="즐겨찾기" className={`w-9 h-9 grid place-items-center rounded-full hover:bg-hover ${fav ? 'text-warn' : 'text-faint'}`}><Star filled={fav} /></button>
        <button type="button" onClick={p.onFull} aria-label={p.full ? '패널로 돌아가기' : '전체화면'} title={p.full ? '패널로 돌아가기 (Esc)' : '전체화면'}
          className="w-9 h-9 grid place-items-center rounded-full hover:bg-hover text-faint"><Icon name={p.full ? 'shrink' : 'expand'} size={17} /></button>
        <button type="button" onClick={p.onClose} aria-label="닫기" className="w-9 h-9 grid place-items-center rounded-full hover:bg-hover text-faint"><Icon name="close" size={17} /></button>
      </div>
      <div className="flex items-center gap-1 px-5 pb-3">
        <span role="tablist" className="inline-flex gap-0.5 p-1 rounded-full bg-hover flex-none">
          {(['info', 'log'] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={p.tab === k} onClick={() => p.onTab(k)}
              className={`h-7 px-3.5 rounded-full text-[12.5px] whitespace-nowrap ${p.tab === k ? 'bg-panel text-fg font-semibold [box-shadow:var(--card-shadow)]' : 'text-muted hover:text-fg'}`}>
              {k === 'info' ? '정보' : '실행 로그'}
              {k === 'log' && p.running && <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent ml-1.5 align-middle" />}
            </button>
          ))}
        </span>
        {p.tab === 'log' && (
          <>
            <span className="flex-1 min-w-2" />
            {p.runs.length > 0 && (
              <Select label="실행 기록" variant="pill" className="min-w-0 max-w-[180px]" value={String(s?.id ?? '')}
                onChange={(v) => p.onViewRun(Number(v))}
                options={p.runs.map((r) => ({ value: String(r.id),
                  label: `#${r.id} ${r.target} · ${RUN_LABEL[r.status]} · ${r.started_at ? new Date(r.started_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : ''}` }))} />
            )}
            <button type="button" onClick={p.onWrap} aria-pressed={p.wrap}
              className={`h-7 px-3 rounded-full text-[12px] whitespace-nowrap flex-none ${p.wrap ? 'bg-accentsoft text-accent' : 'text-muted hover:bg-hover hover:text-fg'}`}>줄바꿈</button>
          </>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto scroll-thin flex flex-col">{p.tab === 'info' ? info : log}</div>
      <div className="flex-none px-5 pt-3 pb-4 border-t border-line soft-edge [box-shadow:0_-8px_16px_-12px_rgb(0_0_0/.12)]">
        <div className="pwrap">{actions}</div>
      </div>
    </>
  )
}
