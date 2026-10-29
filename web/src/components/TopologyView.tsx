import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { api, type TopoNode, type Topology } from '../api'
import { Icon } from '../icons'

// 카드 크기와 간격 (px)
const W = 216, H = 76, GAP_X = 96, GAP_Y = 22, PAD = 28

type Tone = 'net' | 'work' | 'conf' | 'secret' | 'store' | 'other'
const TONE: Record<Tone, string> = {
  net: 'bg-accentsoft text-accent',
  work: 'bg-ok/10 text-ok',
  conf: 'bg-warn/10 text-warn',
  secret: 'bg-fail/10 text-fail',
  store: 'bg-hover text-muted',
  other: 'bg-hover text-muted',
}
const SHORT: Record<string, string> = {
  HorizontalPodAutoscaler: 'HPA', PersistentVolumeClaim: 'PVC', compose: 'compose', volume: 'volume',
}
function toneOf(kind: string): Tone {
  if (kind === 'Ingress' || kind === 'Service') return 'net'
  if (['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob', 'Pod', 'compose'].includes(kind)) return 'work'
  if (kind === 'ConfigMap') return 'conf'
  if (kind === 'Secret') return 'secret'
  if (kind === 'PersistentVolumeClaim' || kind === 'volume') return 'store'
  return 'other'
}
// 카드에 보여줄 한 줄: 복제 수, 이미지 태그, 포트 중 있는 것
function brief(n: TopoNode): string {
  const get = (k: string) => n.summary.find((s) => s[0] === k)?.[1]
  const image = n.summary.find((s) => s[1]?.includes(':') && !['ports', 'replicas', 'type', 'size', 'keys', 'schedule'].includes(s[0]))?.[1]
  return [get('replicas') && `×${get('replicas')}`, get('type'), get('ports'), image && image.split('/').pop(), get('size'), get('keys'), get('schedule')]
    .filter(Boolean).slice(0, 2).join(' · ')
}

/** 열(rank)마다 쌓고, 앞 열과 이어진 위치의 평균으로 순서를 맞춰 선이 덜 엉키게 한다 */
function layout(t: Topology) {
  const ranks = [...new Set(t.nodes.map((n) => n.rank))].sort((a, b) => a - b)
  const cols = ranks.map((r) => t.nodes.filter((n) => n.rank === r).map((n) => n.id))
  const pos = new Map<string, { x: number; y: number }>()
  const place = () => cols.forEach((c, ci) => c.forEach((id, ri) => pos.set(id, { x: PAD + ci * (W + GAP_X), y: PAD + ri * (H + GAP_Y) })))
  place()
  for (let pass = 0; pass < 2; pass++) {
    cols.forEach((c, ci) => {
      if (ci === 0) return
      const score = (id: string) => {
        const ys = t.edges.filter((e) => e.to === id || e.from === id).map((e) => pos.get(e.to === id ? e.from : e.to)!.y)
        return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : pos.get(id)!.y
      }
      c.sort((a, b) => score(a) - score(b))
    })
    place()
  }
  const width = PAD * 2 + cols.length * W + Math.max(0, cols.length - 1) * GAP_X
  const height = PAD * 2 + Math.max(1, ...cols.map((c) => c.length)) * (H + GAP_Y) - GAP_Y
  return { pos, width, height }
}

/** 서비스 폴더의 compose·쿠버네티스 yaml 구성도. 노드를 누르면 오른쪽 패널에서 그 리소스의 yaml 을 보고 고치거나 지운다 */
export function TopologyView({ serviceId, canEdit, onToast }: { serviceId: number; canEdit: boolean; onToast: (m: string) => void }) {
  const [topo, setTopo] = useState<Topology | null>(null)
  const [error, setError] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  // 빈 곳을 마우스로 끌면 판을 움직인다 (터치는 브라우저 기본 스크롤)
  const [panning, setPanning] = useState(false)
  const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null)
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    const el = e.currentTarget
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false }
    el.setPointerCapture(e.pointerId)
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    if (!d.moved) { d.moved = true; setPanning(true) }
    e.currentTarget.scrollLeft = d.left - dx
    e.currentTarget.scrollTop = d.top - dy
  }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setPanning(false)
    if (d && !d.moved) setSel(null) // 끌지 않고 누르기만 했으면 선택 해제
  }

  const load = useCallback(async (keep?: { kind: string; name: string }) => {
    setError('')
    try {
      const t = await api.topology(serviceId)
      setTopo(t)
      if (keep) setSel(t.nodes.find((n) => n.kind === keep.kind && n.name === keep.name)?.id ?? null)
    } catch (e) { setError((e as Error).message) }
  }, [serviceId])
  useEffect(() => { setTopo(null); setSel(null); void load() }, [load])
  useEffect(() => {
    if (!sel) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('textarea')) setSel(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel])

  const lay = useMemo(() => (topo ? layout(topo) : null), [topo])
  const node = topo?.nodes.find((n) => n.id === sel) ?? null
  const focus = hover ?? sel
  const near = useMemo(() => {
    const s = new Set<string>()
    if (focus && topo) topo.edges.forEach((e) => { if (e.from === focus || e.to === focus) { s.add(e.from); s.add(e.to) } })
    return s
  }, [focus, topo])

  if (error && !topo) return <div className="flex-1 grid place-items-center p-6"><p className="text-[13px] text-muted max-w-[420px] text-center">{error}</p></div>
  if (!topo || !lay) return <div className="flex-1 grid place-items-center"><p className="text-[13px] text-muted">불러오는 중…</p></div>
  if (!topo.nodes.length) return (
    <div className="flex-1 grid place-items-center p-6 text-center">
      <div className="flex flex-col gap-1.5">
        <p className="text-[15px] font-medium">구성을 그릴 yaml이 없습니다</p>
        <p className="text-[13px] text-muted">docker-compose.yml 이나 쿠버네티스 yaml 을 서비스 폴더에 두면 여기에 나타납니다.</p>
      </div>
    </div>
  )

  return (
    <div className="relative flex-1 min-w-0 flex overflow-hidden">
      <div className={`flex-1 overflow-auto scroll-thin bg-[rgb(var(--canvas))] select-none ${panning ? 'cursor-grabbing' : 'cursor-grab'}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {/* 점 격자 배경은 그림과 함께 스크롤되도록 안쪽에 깐다 */}
        <div className="relative min-w-full min-h-full" style={{ width: lay.width, height: lay.height,
          backgroundImage: 'radial-gradient(rgb(var(--dot)) 1.2px, transparent 1.3px)', backgroundSize: '22px 22px' }}>
          <svg className="absolute inset-0 pointer-events-none" width={lay.width} height={lay.height} aria-hidden="true">
            <defs>
              <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L8 4L0 8z" fill="rgb(var(--faint))" />
              </marker>
              <marker id="arrOn" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L8 4L0 8z" fill="rgb(var(--accent))" />
              </marker>
            </defs>
            {topo.edges.map((e, i) => {
              const a = lay.pos.get(e.from), b = lay.pos.get(e.to)
              if (!a || !b) return null
              const on = !!focus && (e.from === focus || e.to === focus)
              const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x - 2, y2 = b.y + H / 2
              const back = x2 <= x1 // 같은 열이거나 뒤로 가는 선은 아래로 돌아간다
              const d = back
                ? `M${a.x + W / 2} ${a.y + H} C${a.x + W / 2} ${a.y + H + 40}, ${b.x + W / 2} ${b.y - 40}, ${b.x + W / 2} ${b.y - 2}`
                : `M${x1} ${y1} C${x1 + GAP_X / 2} ${y1}, ${x2 - GAP_X / 2} ${y2}, ${x2} ${y2}`
              return (
                <g key={i} opacity={focus && !on ? 0.25 : 1}>
                  <path d={d} fill="none" stroke={on ? 'rgb(var(--accent))' : 'rgb(var(--faint))'} strokeWidth={on ? 2 : 1.4}
                    markerEnd={on ? 'url(#arrOn)' : 'url(#arr)'} />
                  {on && e.label && !back && (
                    <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="fill-[rgb(var(--muted))] text-[10px] font-mono">{e.label}</text>
                  )}
                </g>
              )
            })}
          </svg>
          {topo.nodes.map((n) => {
            const p = lay.pos.get(n.id)!
            const dim = !!focus && focus !== n.id && !near.has(n.id)
            return (
              <button key={n.id} type="button" onClick={(e) => { e.stopPropagation(); setSel(n.id) }}
                onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}
                title={n.missing ? '파일에 없는 리소스 (클러스터에 따로 있을 수 있습니다)' : n.file}
                style={{ left: p.x, top: p.y, width: W, height: H }}
                className={`absolute text-left rounded-2xl px-3.5 py-2.5 flex flex-col justify-center gap-1 transition-opacity
                  ${n.missing ? 'border border-dashed border-edge bg-transparent' : 'bg-panel border border-line [box-shadow:var(--card-shadow)]'}
                  ${sel === n.id ? 'ring-2 ring-accent border-transparent' : 'hover:border-edge'} ${dim ? 'opacity-35' : ''}`}>
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className={`text-[10px] font-semibold px-1.5 py-px rounded ${TONE[toneOf(n.kind)]}`}>{SHORT[n.kind] ?? n.kind}</span>
                  {n.template && <span className="text-[10px] text-faint">template</span>}
                  {n.status && (
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-muted tabular-nums">
                      <span className={`w-1.5 h-1.5 rounded-full ${n.status.tone === 'ok' ? 'bg-ok' : n.status.tone === 'warn' ? 'bg-warn' : 'bg-faint'}`} />
                      {n.status.ready}/{n.status.total}
                    </span>
                  )}
                </span>
                <span className="font-mono text-[13px] font-semibold truncate">{n.name}</span>
                <span className="text-[11px] text-faint truncate">{n.missing ? '파일에 없음' : brief(n) || ' '}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="absolute left-3 bottom-3 flex items-center gap-2">
        <button type="button" onClick={() => void load(node ? { kind: node.kind, name: node.name } : undefined)}
          className="h-8 px-3 rounded-full bg-panel text-[12px] text-muted hover:text-fg inline-flex items-center gap-1.5 [box-shadow:var(--card-shadow)]">
          <Icon name="refresh" size={13} />다시 불러오기</button>
        {topo.errors.length > 0 && <span className="text-[12px] text-warn bg-panel rounded-full px-3 py-1.5" title={topo.errors.join('\n')}>건너뛴 파일 {topo.errors.length}개</span>}
      </div>

      <aside className={`panel absolute right-0 top-0 bottom-0 sm:right-3.5 sm:top-1 sm:bottom-3.5 w-full sm:w-[420px] bg-panel sm:rounded-2xl border-line sm:border soft-edge flex flex-col overflow-hidden ${node ? 'open shadow-2xl' : ''}`}
        aria-label="리소스 상세" aria-hidden={!node}>
        {node && topo && (
          <NodePanel key={node.id + (topo.files[node.file ?? ''] ?? '')} node={node} topo={topo} serviceId={serviceId} canEdit={canEdit}
            onSelect={setSel} onClose={() => setSel(null)}
            onSaved={(msg, keep) => { onToast(msg); void load(keep) }} />
        )}
      </aside>
    </div>
  )
}

function NodePanel({ node, topo, serviceId, canEdit, onSelect, onClose, onSaved }: {
  node: TopoNode; topo: Topology; serviceId: number; canEdit: boolean
  onSelect: (id: string) => void; onClose: () => void; onSaved: (msg: string, keep?: { kind: string; name: string }) => void
}) {
  const [text, setText] = useState(node.text ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [askDelete, setAskDelete] = useState(false)
  const editable = canEdit && !!node.editable && !node.missing
  const dirty = text !== (node.text ?? '')
  const name = (id: string) => topo.nodes.find((n) => n.id === id)
  const outs = topo.edges.filter((e) => e.from === node.id)
  const ins = topo.edges.filter((e) => e.to === node.id)

  const save = async (value: string | null) => {
    if (!node.file) return
    setBusy(true); setError('')
    try {
      const r = await api.saveTopoNode(serviceId, node.id, topo.files[node.file], value)
      if (value === null) { onClose(); onSaved(`${node.name} 을(를) 지웠습니다`) }
      else onSaved(r.changed ? `${node.name} 을(를) 저장했습니다` : '바뀐 내용이 없습니다', { kind: node.kind, name: node.name })
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const link = (id: string, label: string, dir: 'in' | 'out') => {
    const n = name(id)
    if (!n) return null
    return (
      <button key={dir + id + label} type="button" onClick={() => onSelect(id)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-hover text-left text-[12px]">
        <span className="text-faint w-3">{dir === 'in' ? '←' : '→'}</span>
        <span className={`text-[10px] font-semibold px-1.5 py-px rounded ${TONE[toneOf(n.kind)]}`}>{SHORT[n.kind] ?? n.kind}</span>
        <span className="font-mono truncate">{n.name}</span>
        {label && <span className="ml-auto text-faint font-mono truncate max-w-[40%]">{label}</span>}
      </button>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-start gap-3 px-5 pt-5 pb-3">
        <div className="min-w-0 flex-1">
          <span className={`text-[10.5px] font-semibold px-1.5 py-px rounded ${TONE[toneOf(node.kind)]}`}>{node.kind}</span>
          <h3 className="font-mono text-[16px] font-semibold truncate mt-1">{node.name}</h3>
          <p className="text-[12px] text-faint font-mono truncate">{node.missing ? '파일에 없는 리소스' : node.file}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="닫기" className="w-8 h-8 grid place-items-center rounded-full text-faint hover:text-fg hover:bg-hover"><Icon name="close" size={16} /></button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto scroll-thin px-5 pb-4 flex flex-col gap-4">
        {(node.summary.length > 0 || node.status) && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            {node.status && <><dt className="text-faint">상태</dt><dd>{node.status.ready}/{node.status.total} 준비</dd></>}
            {node.summary.map(([k, v], i) => <div key={i} className="contents"><dt className="text-faint font-mono">{k}</dt><dd className="font-mono break-all">{v}</dd></div>)}
          </dl>
        )}
        {(ins.length > 0 || outs.length > 0) && (
          <section>
            <h4 className="text-[12px] font-medium text-faint mb-1">연결</h4>
            <div className="-mx-2.5">{ins.map((e) => link(e.from, e.label, 'in'))}{outs.map((e) => link(e.to, e.label, 'out'))}</div>
          </section>
        )}
        {node.missing ? (
          <p className="text-[12px] text-muted">다른 리소스가 가리키지만 서비스 폴더의 yaml 에는 없습니다. 클러스터에 직접 만든 것일 수 있습니다.</p>
        ) : node.text !== undefined && (
          <section className="flex flex-col gap-1.5 min-h-0">
            <h4 className="text-[12px] font-medium text-faint">yaml {node.readonly && <span className="text-warn font-normal">· {node.readonly}</span>}</h4>
            {editable
              ? <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={`${node.name} yaml`}
                  className="w-full h-[320px] rounded-xl bg-hover p-3.5 text-[12px] leading-relaxed font-mono whitespace-pre overflow-auto scroll-thin outline-none border border-transparent focus:border-accent resize-y" />
              : <pre className="rounded-xl bg-hover p-3.5 text-[12px] leading-relaxed font-mono whitespace-pre overflow-auto scroll-thin max-h-[360px]">{node.text || '(내용 없음)'}</pre>}
          </section>
        )}
        {error && <p role="alert" className="text-[13px] text-fail whitespace-pre-wrap">{error}</p>}
      </div>

      {editable && (
        <div className="px-5 py-3 border-t border-line flex items-center gap-2">
          {askDelete ? <>
            <span className="text-[12px] text-fail mr-auto">파일에서 이 리소스를 지울까요?</span>
            <button type="button" onClick={() => setAskDelete(false)} className="h-9 px-3 rounded-full text-[13px] text-muted hover:bg-hover">아니요</button>
            <button type="button" disabled={busy} onClick={() => void save(null)} className="h-9 px-4 rounded-full bg-fail text-onaccent text-[13px] disabled:opacity-50">삭제</button>
          </> : <>
            <button type="button" onClick={() => setAskDelete(true)} className="h-9 px-3 rounded-full text-[13px] text-muted hover:text-fail hover:bg-hover mr-auto">삭제</button>
            {dirty && <button type="button" onClick={() => { setText(node.text ?? ''); setError('') }} className="h-9 px-3 rounded-full text-[13px] text-muted hover:bg-hover">변경 취소</button>}
            <button type="button" disabled={busy || !dirty} onClick={() => void save(text)} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] disabled:opacity-50">
              {busy ? '저장하는 중…' : '저장'}</button>
          </>}
        </div>
      )}
    </div>
  )
}
