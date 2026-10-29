import { useMemo, useState } from 'react'
import { Icon, TypeIcon } from '../icons'
import { NAME_RE, VALUE_RE, contains, groupsOf, nodeMake, paramsOf, typeOf, usedBy } from '../model'
import type { MakeNode, Model } from '../types'

type EKind = 'cmd' | 'comp' | 'preset'

export interface EditorSeed { orig: string | null; preset?: { target: string; args: Record<string, string> } }

const inp = 'w-full h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none text-[14px]'

export function NodeEditor({ model: m, seed, onSave, onDelete, onClose }: {
  model: Model
  seed: EditorSeed
  onSave: (node: MakeNode, orig: string | null) => Promise<void>
  onDelete: (name: string) => Promise<void>
  onClose: () => void
}) {
  const nd = seed.orig ? m.nodes[seed.orig] : null
  const [kind, setKind] = useState<EKind>(seed.preset ? 'preset' : nd && nd.kind !== 'help' ? nd.kind : 'cmd')
  const [name, setName] = useState(nd?.name || '')
  const [desc, setDesc] = useState(nd?.desc || '')
  const [group, setGroup] = useState(seed.preset ? m.nodes[seed.preset.target]?.group || '' : nd?.group || '')
  const [cmds, setCmds] = useState((nd?.cmds || []).join('\n'))
  const [mode, setMode] = useState<'seq' | 'par'>(nd?.mode || 'seq')
  const [steps, setSteps] = useState<string[]>(nd?.steps || [])
  const [target, setTarget] = useState(seed.preset?.target || nd?.target || '')
  const [args, setArgs] = useState<Record<string, string>>(
    seed.preset ? Object.fromEntries(Object.entries(seed.preset.args).filter(([, x]) => x.trim())) : { ...(nd?.args || {}) })
  const [askDelete, setAskDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const groups = groupsOf(m).filter((g): g is string => !!g)
  const pool = m.order.filter((n) => n !== 'help' && n !== seed.orig && !(seed.orig && contains(m, n, seed.orig)))
  const targets = m.order.filter((n) => m.nodes[n].kind === 'cmd' && paramsOf(m, n).length > 0)
  const tparams = target ? paramsOf(m, target) : []

  const draft: MakeNode = useMemo(() => {
    const base = { name: name.trim() || 'name', desc: desc.trim(), group: group.trim() || null, comments: nd?.comments || [] }
    if (kind === 'comp') return { ...base, kind: 'comp', mode, steps }
    if (kind === 'preset') return { ...base, kind: 'preset', target, args: Object.fromEntries(Object.entries(args).map(([k, x]) => [k, x.trim()]).filter(([, x]) => x)) }
    return { ...base, kind: 'cmd', cmds: cmds.split('\n').map((c) => c.trimEnd()).filter((c) => c.trim()), ...(nd?.deps ? { deps: nd.deps } : {}) }
  }, [kind, name, desc, group, cmds, mode, steps, target, args, nd])

  const validate = (): string | null => {
    const n = name.trim()
    if (!NAME_RE.test(n)) return '이름은 영문, 숫자, - _ . 만 쓸 수 있습니다'
    if (n === 'help') return 'help는 기본 명령어라 쓸 수 없습니다'
    if (n !== seed.orig && m.nodes[n]) return `${n}은 이미 있습니다`
    if (/[\n#]/.test(desc)) return '설명에는 줄바꿈이나 #을 넣을 수 없습니다'
    if (kind === 'comp' && steps.length < 2) return '복합 명령어는 2개 이상 고르세요'
    if (kind === 'cmd' && !draft.cmds?.length) return '실행할 명령어를 입력하세요'
    if (kind === 'preset') {
      if (!target) return '대상 명령어를 고르세요'
      const miss = tparams.filter((p) => p.required && !draft.args?.[p.name]).map((p) => p.name)
      if (miss.length) return `${miss.join(', ')} 값을 입력하세요`
      if (!Object.keys(draft.args || {}).length) return '고정할 인자를 하나 이상 입력하세요'
      const bad = Object.entries(draft.args || {}).find(([, x]) => !VALUE_RE.test(x))
      if (bad) return `${bad[0]} 값에는 영문, 숫자와 _ . , : / @ + = % - 만 쓸 수 있습니다`
    }
    return null
  }

  const save = async () => {
    const err = validate()
    if (err) { setError(err); return }
    setBusy(true); setError('')
    try { await onSave({ ...draft, name: name.trim() }, seed.orig) } catch (e) { setError((e as Error).message); setBusy(false) }
  }
  const del = async () => {
    setBusy(true)
    try { await onDelete(seed.orig!) } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  const presetsUsing = seed.orig ? m.order.filter((k) => m.nodes[k].kind === 'preset' && m.nodes[k].target === seed.orig) : []
  const users = seed.orig ? usedBy(m, seed.orig).filter((k) => !presetsUsing.includes(k)) : []
  const title = seed.orig ? '노드 편집' : kind === 'preset' ? '프리셋 만들기' : '노드 추가'

  return (
    <div className="p-6 flex flex-col gap-5">
      <div>
        <h3 id="mTitle" className="text-[17px] font-semibold">{title}</h3>
        <p className="text-[13px] text-muted mt-1">make 명령어로 저장되어 터미널에서도 <span className="font-mono">make 이름</span>으로 실행할 수 있습니다.</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5 text-[12px] text-muted">명령어 이름
          <input className={`${inp} font-mono`} value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" spellCheck={false}
            placeholder={kind === 'preset' ? 'backfill-rename-users' : 'clear-cache'} /></label>
        <label className="flex flex-col gap-1.5 text-[12px] text-muted">설명 (주석)
          <input className={inp} value={desc} onChange={(e) => setDesc(e.target.value)} autoComplete="off"
            placeholder={kind === 'preset' ? '사용자 이름 형식 변경' : 'Redis 캐시 비우기'} /></label>
        <label className="flex flex-col gap-1.5 text-[12px] text-muted sm:col-span-2">
          <span>그룹 <span className="text-faint">비워두면 그룹 없음 · Makefile에는 <span className="font-mono">##@ 그룹명</span>으로 저장</span></span>
          <input className={inp} list="groupList" value={group} onChange={(e) => setGroup(e.target.value)} autoComplete="off" placeholder={groups[0] || '배포'} />
          <datalist id="groupList">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </label>
      </div>

      {kind === 'preset' ? (
        <div className="flex flex-col gap-3 p-4 rounded-xl bg-hover">
          <label className="flex flex-col gap-1.5 text-[12px] text-muted">대상 명령어
            <select className={`${inp} font-mono bg-panel`} value={target} onChange={(e) => { setTarget(e.target.value); setArgs({}) }}>
              <option value="" disabled>선택</option>
              {targets.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          {tparams.map((p) => (
            <label key={p.name} className="grid grid-cols-[96px_1fr] items-center gap-3">
              <span className="font-mono text-[12px] text-muted">{p.name}{p.required && <span className="text-fail"> *</span>}</span>
              <input className="w-full h-9 px-3 rounded-full bg-panel border border-line focus:border-accent outline-none text-[13px] font-mono" spellCheck={false} autoComplete="off"
                value={args[p.name] || ''} placeholder={p.def ? `${p.def} (기본값)` : '값 입력'} onChange={(e) => setArgs({ ...args, [p.name]: e.target.value })} />
            </label>
          ))}
          <p className="text-[12px] text-faint">인자를 고정해 둔 바로가기입니다. 같은 스크립트를 값만 바꿔 여러 개 만들 때 씁니다.</p>
        </div>
      ) : (
        <>
          <button type="button" onClick={() => setKind(kind === 'comp' ? 'cmd' : 'comp')} aria-pressed={kind === 'comp'}
            className="flex items-center gap-3 p-3 rounded-xl border border-line hover:bg-hover text-left">
            <span className={`switch ${kind === 'comp' ? 'on' : ''}`} />
            <span><span className="block text-[14px] font-medium">복합 명령어</span><span className="block text-[12px] text-faint">기존 명령어 여러 개를 묶어서 실행합니다</span></span>
          </button>
          {kind === 'cmd' ? (
            <label className="flex flex-col gap-1.5 text-[12px] text-muted">
              <span>실행할 명령어 <span className="text-faint">한 줄에 하나씩 차례대로 실행 · 인자는 <span className="font-mono">$(SCRIPT)</span>처럼 쓰면 실행할 때 입력받습니다</span></span>
              <textarea rows={4} spellCheck={false} value={cmds} onChange={(e) => setCmds(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-bg border border-line focus:border-accent outline-none font-mono text-[13px] leading-relaxed resize-y"
                placeholder="docker compose -f docker-compose.yaml exec -T redis redis-cli FLUSHDB" />
            </label>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <span className="text-[12px] text-muted">실행 방식</span>
                <div className="grid grid-cols-2 gap-2">
                  {([['seq', '순차 실행', '앞 명령이 끝나야 다음 실행. 하나라도 실패하면 중단'], ['par', '병렬 실행', '모두 동시에 시작 (make -j)']] as const).map(([k, l, d]) => (
                    <button key={k} type="button" onClick={() => setMode(k)} className={`p-3 rounded-xl border text-left ${mode === k ? 'border-accent bg-accentsoft' : 'border-line hover:bg-hover'}`}>
                      <span className={`block text-[13px] font-medium ${mode === k ? 'text-accent' : ''}`}>{l}</span>
                      <span className="block text-[11px] text-faint mt-0.5 leading-snug">{d}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-[12px] text-muted">포함할 명령어 <span className="text-faint">· 눌러서 추가/제외</span></span>
                {groupsOf(m).map((g) => {
                  const ns = pool.filter((n) => (m.nodes[n].group || null) === g)
                  if (!ns.length) return null
                  return (
                    <div key={g || '-'} className="flex flex-col gap-1.5">
                      {g && <span className="text-[11px] text-faint">{g}</span>}
                      <div className="flex flex-wrap gap-1.5">
                        {ns.map((n) => {
                          const on = steps.includes(n), tt = typeOf(m.nodes[n])
                          return (
                            <button key={n} type="button" onClick={() => setSteps(on ? steps.filter((x) => x !== n) : [...steps, n])}
                              className={`ty-${tt} inline-flex items-center gap-1.5 h-8 pl-1.5 pr-3 rounded-full border text-[12px] font-mono ${on ? 'border-accent bg-accentsoft text-accent' : 'border-line hover:bg-hover'}`}>
                              <span className="tile w-5 h-5 rounded-full grid place-items-center">{on ? <Icon name="check" size={12} sw={2.6} /> : <TypeIcon t={tt} size={12} sw={2.2} />}</span>{n}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
              {steps.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-muted">{mode === 'seq' ? '실행 순서' : '동시에 실행할 명령어'}</span>
                  <ol className="flex flex-col gap-1">
                    {steps.map((s, i) => (
                      <li key={s} className="flex items-center gap-2 h-10 pl-3 pr-1.5 rounded-xl bg-hover">
                        <span className="w-5 text-[12px] text-faint tabular-nums">{mode === 'seq' ? i + 1 : '∥'}</span>
                        <span className="font-mono text-[13px] flex-1 truncate">{s}</span>
                        {mode === 'seq' && <>
                          <button type="button" aria-label="위로" disabled={i === 0} className="w-7 h-7 grid place-items-center rounded-lg hover:bg-panel text-muted disabled:opacity-30"
                            onClick={() => { const a = [...steps];[a[i - 1], a[i]] = [a[i], a[i - 1]]; setSteps(a) }}><Icon name="up" size={14} sw={2} /></button>
                          <button type="button" aria-label="아래로" disabled={i === steps.length - 1} className="w-7 h-7 grid place-items-center rounded-lg hover:bg-panel text-muted disabled:opacity-30"
                            onClick={() => { const a = [...steps];[a[i + 1], a[i]] = [a[i], a[i + 1]]; setSteps(a) }}><Icon name="down" size={14} sw={2} /></button>
                        </>}
                        <button type="button" aria-label="제외" className="w-7 h-7 grid place-items-center rounded-lg hover:bg-panel text-muted"
                          onClick={() => setSteps(steps.filter((x) => x !== s))}><Icon name="close" size={14} sw={2} /></button>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-muted">Makefile 미리보기</span>
        <pre className="rounded-xl bg-hover p-3.5 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-all text-muted">{(group.trim() ? `##@ ${group.trim()}\n` : '') + nodeMake(draft)}</pre>
      </div>

      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}

      <div className="flex items-center gap-2 flex-wrap">
        {seed.orig && (askDelete ? (
          presetsUsing.length
            ? <span className="text-[12px] text-fail">프리셋 {presetsUsing.join(', ')}이 이 명령어를 씁니다. 먼저 삭제하세요. <button type="button" className="underline" onClick={() => setAskDelete(false)}>닫기</button></span>
            : <>
              <span className="text-[12px] text-fail">{users.length ? `${users.join(', ')}에서도 빠집니다. ` : ''}삭제할까요?</span>
              <button type="button" disabled={busy} onClick={del} className="h-9 px-3 rounded-full bg-fail text-onaccent text-[13px]">삭제</button>
              <button type="button" onClick={() => setAskDelete(false)} className="h-9 px-3 rounded-full text-[13px] text-muted hover:bg-hover">아니요</button>
            </>
        ) : <button type="button" onClick={() => setAskDelete(true)} className="h-9 px-3 rounded-full text-[13px] text-fail hover:bg-fail/10">삭제</button>)}
        <span className="flex-1" />
        <button type="button" onClick={onClose} className="h-9 px-4 rounded-full text-[13px] text-muted hover:bg-hover">취소</button>
        <button type="button" disabled={busy} onClick={save} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] font-medium hover:brightness-110 disabled:opacity-50">
          {busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  )
}
