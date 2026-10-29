import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { api, type Me, type TopoNode, type Topology } from '../api'
import { editorKeyDown } from '../editorKeys'
import { AddNode } from './AddNode'
import { Modal } from './Modal'
import { Select } from './Select'
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
  HorizontalPodAutoscaler: 'HPA', PersistentVolumeClaim: 'PVC', compose: 'compose', volume: 'volume', Dockerfile: 'Dockerfile',
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

// 저장 위치의 키. 문서 순서가 바뀌어도 같은 리소스를 가리키도록 종류와 이름으로 쓴다
const posKey = (n: TopoNode) => `${n.kind}:${n.name}`

/** 고른 파일의 리소스와 그것과 이어진 노드(다른 파일의 Service, Dockerfile, 파일에 없는 참조 등)만 남긴다 */
function filterByFile(t: Topology, file: string): Topology {
  if (!file) return t
  const mine = new Set(t.nodes.filter((n) => n.file === file || n.id.startsWith(`${file}|`)).map((n) => n.id))
  const keep = new Set(mine)
  t.edges.forEach((e) => { if (mine.has(e.from)) keep.add(e.to); if (mine.has(e.to)) keep.add(e.from) })
  return { ...t, nodes: t.nodes.filter((n) => keep.has(n.id)), edges: t.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) }
}

const fileKey = (id: number) => `mb:topoFile:${id}`
const storageGet = (k: string) => { try { return localStorage.getItem(k) || '' } catch { return '' } }
const storageSet = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 저장 불가 환경 */ } }

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
  return pos
}

/** 자동 배치 위에 저장된 위치(끌어서 옮긴 것)와 지금 끌고 있는 위치를 덮어쓴다 */
function place(t: Topology, auto: Map<string, { x: number; y: number }>, saved: Record<string, { x: number; y: number }>) {
  const pos = new Map(auto)
  t.nodes.forEach((n) => { const p = saved[posKey(n)]; if (p) pos.set(n.id, p) })
  const xs = [...pos.values()], width = Math.max(0, ...xs.map((p) => p.x)) + W + PAD, height = Math.max(0, ...xs.map((p) => p.y)) + H + PAD
  return { pos, width, height }
}

/** 서비스 폴더의 compose·쿠버네티스 yaml 구성도. 노드를 누르면 오른쪽 패널에서 그 리소스의 yaml 을 보고 고치거나 지운다 */
export function TopologyView({ serviceId, me, onToast }: { serviceId: number; me: Me; onToast: (m: string) => void }) {
  const canEdit = me.edit
  const [adding, setAdding] = useState(false)
  const [raw, setRaw] = useState<Topology | null>(null)
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
      setRaw(t)
      if (keep) setSel(t.nodes.find((n) => n.kind === keep.kind && n.name === keep.name)?.id ?? null)
    } catch (e) { setError((e as Error).message) }
  }, [serviceId])
  useEffect(() => { setRaw(null); setSel(null); void load() }, [load])
  useEffect(() => {
    if (!sel) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('textarea')) setSel(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sel])

  // 어떤 yaml 파일을 볼지 (비우면 모두). 서비스마다 이 브라우저에 기억한다
  const [file, setFile] = useState(() => storageGet(fileKey(serviceId)))
  useEffect(() => { setFile(storageGet(fileKey(serviceId))) }, [serviceId])
  const yamlFiles = useMemo(() => {
    const count = new Map<string, number>()
    raw?.nodes.forEach((n) => { if (n.file && !n.missing && n.kind !== 'Dockerfile' && n.kind !== 'volume') count.set(n.file, (count.get(n.file) ?? 0) + 1) })
    return [...count.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [raw])
  const activeFile = yamlFiles.some(([f]) => f === file) ? file : ''
  const pickFile = (f: string) => { setFile(f); storageSet(fileKey(serviceId), f); setSel(null) }
  const topo = useMemo(() => (raw ? filterByFile(raw, activeFile) : null), [raw, activeFile])

  const auto = useMemo(() => (topo ? layout(topo) : null), [topo])
  const [saved, setSaved] = useState<Record<string, { x: number; y: number }>>({})
  useEffect(() => { if (raw) setSaved(raw.positions || {}) }, [raw])
  const lay = useMemo(() => (topo && auto ? place(topo, auto, saved) : null), [topo, auto, saved])

  // 카드를 마우스로 끌어 옮긴다. 놓으면 저장하고, 끌지 않았으면 그냥 누른 것(선택)
  const mouseHandled = useRef(false) // 마우스로 누른 것은 onNodeUp 이 처리했다 (터치·키보드는 onClick)
  const nodeDrag = useRef<{ id: string; key: string; x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null)
  const persist = (next: Record<string, { x: number; y: number }>) => { api.saveTopoPositions(serviceId, next).catch((e) => setError((e as Error).message)) }
  const onNodeDown = (e: PointerEvent<HTMLButtonElement>, n: TopoNode) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !lay) return
    e.stopPropagation()
    const p = lay.pos.get(n.id)!
    nodeDrag.current = { id: n.id, key: posKey(n), x: e.clientX, y: e.clientY, ox: p.x, oy: p.y, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onNodeMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = nodeDrag.current
    if (!d) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    d.moved = true
    setSaved((s) => ({ ...s, [d.key]: { x: Math.max(0, Math.round(d.ox + dx)), y: Math.max(0, Math.round(d.oy + dy)) } }))
  }
  const onNodeUp = (e: PointerEvent<HTMLButtonElement>) => {
    const d = nodeDrag.current
    nodeDrag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    if (d) mouseHandled.current = true
    if (d?.moved) setSaved((s) => { persist(s); return s })
    else if (d) setSel(d.id)
  }
  const resetLayout = () => { setSaved({}); persist({}) }
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
        {canEdit && <button type="button" onClick={() => setAdding(true)} className="mt-2 self-center h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] font-semibold">+ 노드 추가</button>}
      </div>
      {adding && <Modal onClose={() => setAdding(false)}><AddNode serviceId={serviceId} me={me} topo={raw!} preferFile={activeFile} onClose={() => setAdding(false)}
        onDone={(msg, keep) => { setAdding(false); onToast(msg); void load(keep) }} /></Modal>}
    </div>
  )

  return (
    <div className="relative flex-1 min-w-0 flex overflow-hidden">
      <div className="flex-1 min-w-0 flex flex-col">
      {yamlFiles.length > 1 && (
        <div className="flex-none px-3 pt-1 pb-2 flex items-center gap-2">
          <div className="w-[300px] max-w-full">
            <Select label="볼 파일" value={activeFile} onChange={pickFile} options={[
              { value: '', label: '모든 파일', description: `yaml ${yamlFiles.length}개` },
              ...yamlFiles.map(([f, c]) => ({ value: f, label: f, description: `리소스 ${c}개` })),
            ]} />
          </div>
          {activeFile && <span className="text-[12px] text-faint hidden sm:inline">이 파일과 이어진 노드도 함께 보입니다</span>}
        </div>
      )}
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
                    strokeDasharray={e.kind === 'ref' ? '4 4' : undefined} markerEnd={on ? 'url(#arrOn)' : 'url(#arr)'} />
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
              <button key={n.id} type="button" onClick={(e) => { e.stopPropagation(); if (mouseHandled.current) mouseHandled.current = false; else setSel(n.id) }}
                onPointerDown={(e) => onNodeDown(e, n)} onPointerMove={onNodeMove} onPointerUp={onNodeUp} onPointerCancel={onNodeUp}
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
                <span className="text-[11px] text-faint truncate">{n.missing ? (n.editable ? '아직 없음 · 눌러서 만들기' : '파일에 없음') : brief(n) || ' '}</span>
              </button>
            )
          })}
        </div>
      </div>
      </div>

      {canEdit && (
        <button type="button" onClick={() => setAdding(true)}
          className="absolute right-4 bottom-3 h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] font-semibold inline-flex items-center gap-1.5 hover:brightness-110 shadow-lg">
          <Icon name="plus" size={14} sw={2.4} />노드 추가</button>
      )}
      {adding && <Modal onClose={() => setAdding(false)}><AddNode serviceId={serviceId} me={me} topo={raw!} preferFile={activeFile} onClose={() => setAdding(false)}
        onDone={(msg, keep) => { setAdding(false); onToast(msg); void load(keep) }} /></Modal>}

      <div className="absolute left-3 bottom-3 flex items-center gap-2">
        <button type="button" onClick={() => void load(node ? { kind: node.kind, name: node.name } : undefined)}
          className="h-8 px-3 rounded-full bg-panel text-[12px] text-muted hover:text-fg inline-flex items-center gap-1.5 [box-shadow:var(--card-shadow)]">
          <Icon name="refresh" size={13} />다시 불러오기</button>
        {Object.keys(saved).length > 0 && (
          <button type="button" onClick={resetLayout} title="끌어서 옮긴 위치를 지우고 자동으로 배치합니다"
            className="h-8 px-3 rounded-full bg-panel text-[12px] text-muted hover:text-fg [box-shadow:var(--card-shadow)]">자동 정렬</button>
        )}
        <Legend kinds={new Set(topo.edges.map((e) => e.kind))} />
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

// 화면에 있는 선 종류만 뜻을 보여 준다
function Legend({ kinds }: { kinds: Set<string> }) {
  const items = ([
    ['start', false, '먼저 켜짐 → 나중'],
    ['traffic', false, '요청 흐름'],
    ['ref', true, '설정·볼륨 사용'],
  ] as const).filter(([k]) => kinds.has(k))
  if (!items.length) return null
  return (
    <span className="h-8 px-3 rounded-full bg-panel text-[11.5px] text-muted inline-flex items-center gap-3 [box-shadow:var(--card-shadow)]">
      {items.map(([k, dashed, label]) => (
        <span key={k} className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <svg width="22" height="8" aria-hidden="true"><path d="M1 4H16" stroke="rgb(var(--faint))" strokeWidth="1.4" strokeDasharray={dashed ? '3 3' : undefined} /><path d="M15 1L21 4L15 7z" fill="rgb(var(--faint))" /></svg>
          {label}
        </span>
      ))}
    </span>
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
  // 아직 없는 Dockerfile 처럼 missing 이어도 editable 이면 써서 만들 수 있다
  const editable = canEdit && !!node.editable
  const dirty = text !== (node.text ?? '')
  const name = (id: string) => topo.nodes.find((n) => n.id === id)
  const outs = topo.edges.filter((e) => e.from === node.id)
  const ins = topo.edges.filter((e) => e.to === node.id)

  const save = async (value: string | null) => {
    if (!node.file) return
    setBusy(true); setError('')
    try {
      const r = await api.saveTopoNode(serviceId, node.id, topo.files[node.file] ?? '', value)
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
          <p className="text-[12px] text-faint font-mono truncate">{node.missing ? (node.editable ? `${node.file} · 아직 없음, 저장하면 만듭니다` : '파일에 없는 리소스') : node.file}</p>
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
            <div className="-mx-2.5">{ins.map((e) => link(e.from, e.kind === 'start' ? '먼저 켜짐' : e.label, 'in'))}{outs.map((e) => link(e.to, e.kind === 'start' ? '나중에 켜짐' : e.label, 'out'))}</div>
          </section>
        )}
        {node.missing && !node.editable ? (
          <p className="text-[12px] text-muted">다른 리소스가 가리키지만 서비스 폴더의 yaml 에는 없습니다. 클러스터에 직접 만든 것일 수 있습니다.</p>
        ) : node.text !== undefined && (
          <section className="flex flex-col gap-1.5 min-h-0">
            <h4 className="text-[12px] font-medium text-faint">{node.kind === 'Dockerfile' ? 'Dockerfile' : 'yaml'} {node.readonly && <span className="text-warn font-normal">· {node.readonly}</span>}</h4>
            {editable
              ? <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} aria-label={`${node.name} yaml`}
                  placeholder={node.kind === 'Dockerfile' ? 'FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nCMD ["python", "main.py"]' : undefined}
                  onKeyDown={(e) => editorKeyDown(e, setText, () => { if (dirty && !busy) void save(text) })}
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
            {node.kind === 'Dockerfile'
              ? <span className="text-[12px] text-faint mr-auto">빌드는 Makefile 이나 compose 로 실행하세요</span>
              : <button type="button" onClick={() => setAskDelete(true)} className="h-9 px-3 rounded-full text-[13px] text-muted hover:text-fail hover:bg-hover mr-auto">삭제</button>}
            {dirty && <button type="button" onClick={() => { setText(node.text ?? ''); setError('') }} className="h-9 px-3 rounded-full text-[13px] text-muted hover:bg-hover">변경 취소</button>}
            <button type="button" disabled={busy || !dirty} onClick={() => void save(text)} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] disabled:opacity-50">
              {busy ? '저장하는 중…' : '저장'}</button>
          </>}
        </div>
      )}
    </div>
  )
}
