import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, api, type Me } from './api'
import { CommandList, type ListHandle, type NodeState } from './components/CommandList'
import { InitMakefile } from './components/InitMakefile'
import { Login } from './components/Login'
import { OtpSetup } from './components/OtpSetup'
import { StatusChip } from './components/ServiceStatus'
import { ThemeToggle } from './components/ThemeToggle'
import { AddServer } from './components/AddServer'
import { DeleteServer } from './components/DeleteServer'
import { Modal } from './components/Modal'
import { NodeEditor, type EditorSeed } from './components/NodeEditor'
import { Panel, runLine } from './components/Panel'
import { ServerDashboard } from './components/ServerDashboard'
import { ServerList } from './components/ServerList'
import { ServiceUsage } from './components/ServiceUsage'
import { Settings } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { FilesModal } from './components/FilesModal'
import { Icon } from './icons'
import { deleteNode, upsertNode } from './model'
import { useToast } from './toast'
import type { Layout, MakeNode, RunInfo, RunStatus, ServerWithServices, ServiceDetail, StepStatus } from './types'
import { useRunStream } from './useRunStream'

// 화면 위치를 주소(#/server/이름, #/service/번호)에 남겨 브라우저·휴대폰 뒤로가기가 되게 한다
function parseHash(): { srv: string | null; svc: number | null } | null {
  const m = location.hash.match(/^#\/(server|service)\/(.+)$/)
  if (m) return m[1] === 'service' ? { srv: null, svc: Number(m[2]) || null } : { srv: decodeURIComponent(m[2]), svc: null }
  return location.hash === '#/' ? { srv: null, svc: null } : null
}
const hashOf = (srv: string | null, svc: number | null) => (svc ? `#/service/${svc}` : srv ? `#/server/${encodeURIComponent(srv)}` : '#/')

const isMobile = () => { try { return window.matchMedia('(max-width: 1023px)').matches } catch { return false } }

const storage = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* 저장 불가 환경 */ } },
}

export function App() {
  const [auth, setAuth] = useState<'checking' | 'out' | 'in'>('checking')
  const [me, setMe] = useState<Me | null>(null)
  const check = useCallback(() => { api.me().then((m) => { setMe(m); setAuth('in') }).catch(() => setAuth('out')) }, [])
  useEffect(check, [check])
  if (auth === 'checking') return null
  if (auth === 'out' || !me) return <Login onDone={check} />
  const logout = () => { setMe(null); setAuth('out') }
  if (me.otp.setup_required) return <RequireOtp me={me} onDone={check} onLogout={logout} />
  return <Main me={me} onLogout={logout} />
}

// 관리자·편집자가 2단계 인증을 아직 등록하지 않았으면 다른 화면 대신 이것만 보여준다
function RequireOtp({ me, onDone, onLogout }: { me: Me; onDone: () => void; onLogout: () => void }) {
  return (
    <div className="min-h-full grid place-items-center p-4 viewport cursor-default">
      <div className="w-full max-w-[520px] bg-panel border border-line rounded-2xl shadow-xl p-7 flex flex-col gap-5">
        <div>
          <h1 className="text-[18px] font-semibold">2단계 인증 등록</h1>
          <p className="text-[13px] text-muted mt-1">{me.admin ? '관리자' : '편집 권한이 있는 사용자'}는 2단계 인증을 등록해야 Makeboard 를 쓸 수 있습니다. 다음 로그인부터는 비밀번호와 함께 인증 앱의 코드를 입력합니다.</p>
        </div>
        <OtpSetup onDone={onDone} />
        <button type="button" onClick={() => api.logout().finally(onLogout)} className="-mt-2 self-start text-[12px] text-muted hover:text-fg">로그아웃</button>
      </div>
    </div>
  )
}

const STEP_TO_NODE: Partial<Record<StepStatus, NodeState>> = { queued: 'queued', running: 'running', ok: 'ok', failed: 'fail', stopped: 'stopped' }
const RUN_TO_NODE: Record<RunStatus, NodeState> = { running: 'running', ok: 'ok', failed: 'fail', stopped: 'stopped' }
const RUN_LABEL = { running: '실행 중', ok: '완료', failed: '실패', stopped: '중지됨' }

function Main({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const toast = useToast()
  const [servers, setServers] = useState<ServerWithServices[]>([])
  const [svcId, setSvcId] = useState<number | null>(() => { const h = parseHash(); return h ? h.svc : isMobile() ? null : Number(storage.get('mb:svc')) || null })
  // 서비스를 안 열었으면 이 서버의 대시보드를 가운데에 보여준다
  // 모바일은 첫 화면을 서버 목록으로 시작한다
  const [srvId, setSrvId] = useState<string | null>(() => { const h = parseHash(); return h ? h.srv : isMobile() ? null : storage.get('mb:srv') || null })
  const [drawer, setDrawer] = useState(false)
  const [showUsage, setShowUsage] = useState(() => storage.get('mb:usage') === '1')
  const [detail, setDetail] = useState<ServiceDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [sel, setSel] = useState<string | null>(null)
  const [tab, setTab] = useState<'info' | 'log'>('info')
  const [full, setFull] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [params, setParams] = useState<Record<string, Record<string, string>>>({})
  const [confirm, setConfirm] = useState<string | null>(null)
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [viewRun, setViewRun] = useState<number | null>(null)
  const [live, setLive] = useState<Set<number>>(() => new Set())
  // 실행 버튼을 누른 뒤 서버가 실행 번호를 줄 때까지의 명령어, 그리고 마지막으로 실행한 명령어
  const [pending, setPending] = useState<string | null>(null)
  const [runTarget, setRunTarget] = useState<{ id: number; target: string } | null>(null)
  const [editor, setEditor] = useState<EditorSeed | null>(null)
  const [modal, setModal] = useState<'source' | 'agent' | 'settings' | null>(null)
  const [removing, setRemoving] = useState<ServerWithServices | null>(null)
  const [editing, setEditing] = useState<ServerWithServices | null>(null)
  const list = useRef<ListHandle>(null)

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) onLogout()
    else toast((e as Error).message)
  }, [onLogout, toast])

  // 서버 목록과 CPU/RAM 은 5초마다 새로 받는다
  const loadServers = useCallback(() => api.servers().then(setServers).catch(fail), [fail])
  // 탭이 안 보일 때는 멈추고, 다시 보이면 바로 갱신한다
  useEffect(() => {
    loadServers()
    const t = window.setInterval(() => { if (!document.hidden) loadServers() }, 5000)
    const onShow = () => { if (!document.hidden) loadServers() }
    document.addEventListener('visibilitychange', onShow)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onShow) }
  }, [loadServers])

  // 지운 서버·서비스를 가리키고 있으면 정리한다. 아무것도 안 골랐으면 서버 목록이 첫 화면이다.
  useEffect(() => {
    if (!servers.length) return
    if (svcId && !servers.some((s) => s.services.some((x) => x.id === svcId))) setSvcId(null)
    if (srvId && !servers.some((s) => s.id === srvId)) setSrvId(null)
  }, [servers, svcId, srvId])
  useEffect(() => { storage.set('mb:srv', srvId || '') }, [srvId])
  const openServer = (id: string) => { setSvcId(null); setSrvId(id); setDrawer(false) }
  const openHome = () => { setSvcId(null); setSrvId(null); setDrawer(false) }

  // 화면이 바뀌면 주소에 남기고(처음 한 번은 바꿔치기), 뒤로가기를 누르면 그 주소의 화면으로 돌아간다
  const firstNav = useRef(true)
  useEffect(() => {
    const h = hashOf(svcId ? null : srvId, svcId)
    if (location.hash === h) { firstNav.current = false; return }
    if (firstNav.current) { history.replaceState(null, '', h); firstNav.current = false } else history.pushState(null, '', h)
  }, [srvId, svcId])
  useEffect(() => {
    const onPop = () => {
      const h = parseHash() || { srv: null, svc: null }
      setSvcId(h.svc)
      if (!h.svc) setSrvId(h.srv)
      setDrawer(false)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const openService = (id: number) => {
    const owner = servers.find((s) => s.services.some((x) => x.id === id))
    if (owner) setSrvId(owner.id)
    setSvcId(id)
  }

  const loadRuns = useCallback((id: number) => api.runs(id).then(setRuns).catch(() => {}), [])

  useEffect(() => {
    storage.set('mb:svc', svcId ? String(svcId) : '')
    if (!svcId) { setDetail(null); setSel(null); setConfirm(null); setRuns([]); setViewRun(null); return }
    let cancelled = false
    setLoading(true); setDetail(null); setSel(null); setConfirm(null); setFull(false); setRuns([]); setViewRun(null)
    api.service(svcId).then((d) => { if (!cancelled) setDetail(d) }).catch(fail).finally(() => { if (!cancelled) setLoading(false) })
    api.runs(svcId).then((r) => { if (!cancelled) { setRuns(r); setViewRun(r[0]?.id ?? null) } }).catch(() => {})
    return () => { cancelled = true }
  }, [svcId, fail])

  const stream = useRunStream(viewRun, (status, target) => {
    if (svcId) loadRuns(svcId)
    toast(`make ${target} ${RUN_LABEL[status]}`)
  })
  const running = stream?.status === 'running' || !!pending
  const model = detail?.model ?? null
  const layout: Layout = detail?.layout || {}

  const favorites = (layout.favorites || []).filter((n) => model?.nodes[n])

  // 카드에 보여줄 실행 상태. 누르는 즉시(서버 응답 전) 실행 중으로 보이고, 복합 명령어는 실행 전체 상태를 따른다
  const nodeStatus = useMemo(() => {
    const out: Record<string, NodeState> = {}
    if (pending) out[pending] = 'running'
    if (!stream || !(live.has(stream.id) || stream.status === 'running')) return out
    Object.values(stream.steps).forEach((s) => { const v = STEP_TO_NODE[s.status]; if (v) out[s.node] = v })
    const target = stream.run?.target ?? (runTarget?.id === stream.id ? runTarget.target : undefined)
    if (target && !out[target]) out[target] = RUN_TO_NODE[stream.status]
    return out
  }, [stream, live, pending, runTarget])

  const saveLayout = (next: Layout) => {
    if (!svcId) return
    setDetail((d) => (d ? { ...d, layout: next } : d))
    api.saveLayout(svcId, next).catch(fail)
  }

  // ---- 실행
  const requestRun = (n: string) => {
    if (!model || !detail || running) return
    const { missing } = runLine(model, n, params[n] || {})
    if (missing.length) { setSel(n); setTab('info'); toast(`${missing.join(', ')} 값을 입력한 뒤 실행하세요`); return }
    if (detail.server?.environment === 'prod' && model.nodes[n].kind !== 'help') { setSel(n); setTab('info'); setConfirm(n); return }
    void doRun(n)
  }
  const doRun = async (n: string) => {
    if (!model || !svcId) return
    setConfirm(null)
    setPending(n)
    try {
      const { run_id } = await api.run(svcId, n, runLine(model, n, params[n] || {}).vars)
      setLive((s) => new Set(s).add(run_id))
      setRunTarget({ id: run_id, target: n })
      setViewRun(run_id); setSel(n); setTab('log')
      loadRuns(svcId)
    } catch (e) { fail(e) } finally { setPending(null) }
  }
  const stop = () => { if (stream) api.stop(stream.id).catch(fail) }

  // ---- 편집
  const saveNode = async (node: MakeNode, orig: string | null) => {
    if (!model || !detail || !svcId) return
    const next = upsertNode(model, orig, node)
    const res = await api.saveModel(svcId, next, detail.sha)
    setDetail(res)
    // 이름을 바꿨으면 즐겨찾기도 따라간다
    if (orig && orig !== node.name && (layout.favorites || []).includes(orig)) {
      saveLayout({ ...layout, favorites: (layout.favorites || []).map((f) => (f === orig ? node.name : f)) })
    }
    setEditor(null); setSel(node.name); setTab('info')
    toast(orig ? `${node.name}을 저장했습니다` : `${node.name}을 추가했습니다`)
  }
  const removeNode = async (name: string) => {
    if (!model || !detail || !svcId) return
    const res = await api.saveModel(svcId, deleteNode(model, name), detail.sha)
    setDetail(res); setEditor(null); setSel(null)
    toast(`${name}을 삭제했습니다`)
  }
  const sync = async () => {
    if (!svcId) return
    try { setDetail(await api.sync(svcId)) } catch (e) { fail(e); throw e }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editor || modal) return
      if (drawer) { setDrawer(false); return }
      if (full) setFull(false)
      else if (sel) { setSel(null); setConfirm(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full, sel, editor, modal, drawer])

  const select = (n: string | null) => { setSel(n); setConfirm(null); if (n) setTab((t) => (t === 'log' && !running ? 'info' : t)); else setFull(false) }
  const focus = (n: string) => { setSel(n); setTab('info'); setConfirm(null); list.current?.focus(n) }
  const panelOpen = !!(sel && model?.nodes[sel])
  const srv = detail?.server
  const curServerId = svcId ? (servers.find((s) => s.services.some((x) => x.id === svcId))?.id ?? srv?.id ?? null) : srvId
  const curServer = servers.find((s) => s.id === curServerId) || null
  // 상태는 5초마다 받는 서버 목록에 들어 있으므로 상세를 다시 부르지 않고 그걸 쓴다
  const liveStatus = servers.flatMap((x) => x.services).find((x) => x.id === svcId)?.status ?? detail?.status

  return (
    <div className="h-full flex bg-bg" style={{ paddingLeft: 'env(safe-area-inset-left, 0px)', paddingRight: 'env(safe-area-inset-right, 0px)' }}>
      <Sidebar servers={servers} current={curServerId} disabled={!!running} open={drawer} onClose={() => setDrawer(false)}
        onPick={openServer} onHelp={me.admin ? () => { setDrawer(false); setModal('agent') } : undefined}
        onDelete={me.admin ? (s) => { setDrawer(false); setRemoving(s) } : undefined}
        onEdit={me.admin ? (s) => { setDrawer(false); setEditing(s) } : undefined} />

      <main className="flex-1 min-w-0 flex flex-col h-full">
        <header className="h-14 lg:h-[68px] flex-none flex items-center gap-3 px-3 lg:pl-1 lg:pr-3.5 lg:pt-3.5 lg:pb-2">
          <button type="button" onClick={() => setDrawer(true)} aria-label="서버 목록 열기" aria-expanded={drawer}
            className="lg:hidden w-9 h-9 grid place-items-center rounded-full bg-panel text-muted hover:text-fg flex-none [box-shadow:var(--card-shadow)]">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
          </button>
          {(svcId || curServer) && (
            <button type="button" disabled={!!running} onClick={() => (svcId && curServerId ? openServer(curServerId) : openHome())}
              aria-label={svcId ? '서버 대시보드로 돌아가기' : '서버 목록으로 돌아가기'} title="뒤로"
              className="w-8 h-8 grid place-items-center rounded-full bg-panel text-muted hover:text-fg flex-none disabled:opacity-40 [box-shadow:var(--card-shadow)]">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
            </button>
          )}
          <div className="flex items-center gap-2 min-w-0 text-sm">
            {!svcId && !curServer ? (
              <span className="font-semibold">서버</span>
            ) : !svcId && curServer ? <>
              <button type="button" onClick={openHome} className="font-semibold hover:underline underline-offset-2">서버</button>
              <Icon name="chevron" size={14} sw={2} className="text-faint" />
              <span className="font-mono text-[13px] truncate">{curServer.id}</span>
            </> : detail ? <>
              <button type="button" disabled={!!running} onClick={() => srv && openServer(srv.id)} title="서버 대시보드로"
                className="font-mono text-muted text-[13px] hidden sm:inline hover:text-fg hover:underline underline-offset-2">{srv?.id}</button>
              <Icon name="chevron" size={14} sw={2} className="text-faint hidden sm:inline" />
              <span className="font-semibold truncate">{detail.name}</span>
              {!srv?.online && <span className="text-[11px] px-1.5 rounded bg-hover text-muted">오프라인</span>}
              {srv?.online && <StatusChip status={liveStatus} />}
              {detail.sha && <span className="text-[12px] text-faint font-mono hidden md:inline" title="Makefile sha256">{detail.sha.slice(0, 8)}</span>}
              {model?.readonly && <span className="text-[11px] px-2 py-0.5 rounded bg-warn/10 text-warn truncate" title={model.readonly}>읽기 전용</span>}
            </> : <span className="text-muted">{loading ? '불러오는 중…' : '서비스를 고르세요'}</span>}
          </div>
          <div className="flex-1" />
          {detail && liveStatus && (
            <button type="button" onClick={() => setShowUsage((v) => { storage.set('mb:usage', v ? '0' : '1'); return !v })} aria-pressed={showUsage}
              className={`inline-flex h-8 items-center px-3.5 rounded-full text-[13px] ${showUsage ? 'bg-accentsoft text-accent font-semibold' : 'bg-panel text-muted hover:text-fg [box-shadow:var(--card-shadow)]'}`}>리소스</button>
          )}
          {detail && <button type="button" onClick={() => setModal('source')} className="hidden sm:inline-flex h-8 items-center px-3.5 rounded-full bg-panel text-[13px] text-muted hover:text-fg [box-shadow:var(--card-shadow)]">파일</button>}
          {model && !model.readonly && me.edit && (
            <button type="button" onClick={() => setEditor({ orig: null })} className="inline-flex h-8 items-center gap-1.5 px-4 rounded-full text-[13px] font-semibold bg-accent text-onaccent hover:brightness-110">
              <Icon name="plus" size={14} sw={2.4} />노드 추가
            </button>
          )}
          <button type="button" onClick={() => setModal('settings')} aria-label="설정" title="설정"
            className="w-8 h-8 grid place-items-center rounded-full text-faint hover:text-fg hover:bg-panel"><Icon name="settings" size={16} /></button>
          <ThemeToggle />
          <button type="button" onClick={() => api.logout().finally(onLogout)} aria-label={`로그아웃 (${me.name})`} title={`로그아웃 (${me.name} · ${me.user})`}
            className="w-8 h-8 grid place-items-center rounded-full text-faint hover:text-fg hover:bg-panel"><Icon name="logout" size={16} /></button>
        </header>

        {svcId && detail && liveStatus && showUsage && <ServiceUsage serviceId={svcId} />}
        <div className="relative flex-1 min-h-0 flex overflow-hidden">
          {!svcId && !curServer && servers.length > 0 ? (
            <ServerList servers={servers} onOpen={openServer} onAdd={me.admin ? () => setModal('agent') : undefined} />
          ) : !svcId && curServer ? (
            <ServerDashboard server={curServer} onOpen={openService} onEdit={me.admin ? () => setEditing(curServer) : undefined} />
          ) : model && detail ? (
            <CommandList ref={list} model={model} favorites={favorites} status={nodeStatus} selected={sel} running={!!running}
              panelOpen={panelOpen} onSelect={select} onRun={requestRun} onStop={stop}
              onFav={(n) => saveLayout({ ...layout, favorites: favorites.includes(n) ? favorites.filter((x) => x !== n) : [...favorites, n] })} />
          ) : (
            <div className="viewport cursor-default flex-1 grid place-items-center p-6">
              <div className={`${detail && !model && !detail.makefile && !detail.sync_error ? 'w-full max-w-[640px]' : 'max-w-[420px]'} text-center flex flex-col items-center gap-3`}>
                {detail && !model && !detail.makefile && !detail.sync_error ? (me.edit
                  ? <InitMakefile service={detail} onError={fail} onDone={(d) => { setDetail(d); loadServers() }} />
                  : <><p className="text-[15px] font-medium">Makefile이 없습니다</p><p className="text-[13px] text-muted">편집 권한이 있는 사용자가 만들 수 있습니다.</p></>
                ) : detail && !model ? <>
                  <p className="text-[15px] font-medium">Makefile을 불러오지 못했습니다</p>
                  <p className="text-[13px] text-muted">{detail.sync_error || `${detail.path}/Makefile 이 비어 있습니다.`}</p>
                  <button type="button" onClick={() => sync().catch(() => {})} className="h-9 px-4 rounded-full bg-panel text-[13px] hover:bg-hover [box-shadow:var(--card-shadow)]">다시 불러오기</button>
                </> : servers.length === 0 ? <>
                  <p className="text-[15px] font-medium">연결된 서버가 없습니다</p>
                  <p className="text-[13px] text-muted">관리할 서버에 에이전트를 설치하고 실행하면 서버와 서비스가 자동으로 나타납니다.</p>
                  {me.admin && <button type="button" onClick={() => setModal('agent')} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] font-semibold">서버 추가</button>}
                </> : <p className="text-[13px] text-muted">{loading ? '불러오는 중…' : '왼쪽에서 서버를 고르세요'}</p>}
              </div>
            </div>
          )}

          {svcId && <aside className={`panel absolute right-0 top-0 bottom-0 sm:right-3.5 sm:top-1 sm:bottom-3.5 w-full sm:w-[400px] bg-panel sm:rounded-2xl border-line sm:border soft-edge flex flex-col overflow-hidden ${panelOpen ? 'open shadow-2xl' : ''} ${panelOpen && full ? 'full' : ''}`}
            aria-label="노드 상세" aria-hidden={!panelOpen}>
            {panelOpen && model && detail && sel && (
              <Panel model={model} node={sel} service={detail} favorites={favorites} tab={tab} full={full} wrap={wrap}
                params={params[sel] || {}} confirm={confirm === sel} stream={stream} live={!!stream && (live.has(stream.id) || stream.status === 'running')}
                runs={runs} running={!!running} readonly={model.readonly || (me.edit ? null : '편집 권한이 없습니다')}
                onTab={setTab} onFull={() => setFull((f) => !f)} onWrap={() => setWrap((w) => !w)}
                onParam={(k, v) => setParams((p) => ({ ...p, [sel]: { ...(p[sel] || {}), [k]: v } }))}
                onRun={() => requestRun(sel)} onConfirm={() => void doRun(sel)} onCancelConfirm={() => setConfirm(null)} onStop={stop}
                onPreset={() => setEditor({ orig: null, preset: { target: sel, args: { ...(params[sel] || {}) } } })}
                onEdit={() => setEditor({ orig: sel })} onClose={() => select(null)}
                onFav={() => saveLayout({ ...layout, favorites: favorites.includes(sel) ? favorites.filter((x) => x !== sel) : [...favorites, sel] })}
                onFocus={focus} onViewRun={setViewRun} />
            )}
          </aside>}
        </div>
      </main>

      {editor && model && (
        <Modal onClose={() => setEditor(null)}>
          <NodeEditor model={model} seed={editor} onSave={saveNode} onDelete={removeNode} onClose={() => setEditor(null)} />
        </Modal>
      )}
      {modal === 'source' && detail && <Modal wide onClose={() => setModal(null)}><FilesModal service={detail} canEdit={me.edit} onSync={sync} onClose={() => setModal(null)} /></Modal>}
      {modal === 'settings' && <Modal onClose={() => setModal(null)}>
        <Settings me={me} onClose={() => setModal(null)} onError={fail} onSaved={(msg) => { loadServers(); toast(msg) }} />
      </Modal>}
      {modal === 'agent' && <Modal onClose={() => setModal(null)}><AddServer servers={servers} onClose={() => setModal(null)} /></Modal>}
      {editing && <Modal onClose={() => setEditing(null)}><AddServer servers={servers} edit={editing} onClose={() => setEditing(null)} /></Modal>}
      {removing && <Modal onClose={() => setRemoving(null)}><DeleteServer server={removing} onClose={() => setRemoving(null)} onDone={(message) => {
        if (removing.services.some((v) => v.id === svcId)) { setSvcId(null); setDetail(null) }
        if (removing.id === srvId) setSrvId(null)
        setRemoving(null); loadServers(); toast(message)
      }} /></Modal>}
    </div>
  )
}
