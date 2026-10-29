import { useState } from 'react'
import { api } from '../api'
import { usePoints } from '../usePoints'
import { Icon } from '../icons'
import type { Metrics, ServerWithServices, ServiceItem } from '../types'
import { Gauge, GaugeRow } from './Gauge'
import { StatusDot, summarize } from './ServiceStatus'
import { TimeChart, fmtBytes, type Point } from './TimeChart'

const S1 = 'rgb(var(--series-1))'

function uptime(sec?: number): string {
  if (!sec) return '-'
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`
}

// CPU 카드 아래 사양: "2소켓 · 28코어 · 56스레드". 0.1 에이전트는 논리 코어 수만 보낸다
function cpuSpec(m: Metrics): string {
  if (!m.threads) return m.cores ? `${m.cores}코어` : ''
  return [m.sockets ? `${m.sockets}소켓` : '', `${m.cores_physical || m.threads}코어`, `${m.threads}스레드`].filter(Boolean).join(' · ')
}

function Stat({ label, value, sub, detail, pct, warnAbove = 85 }: { label: string; value: string; sub?: string; detail?: string; pct?: number; warnAbove?: number }) {
  return (
    <div className="bg-panel border border-line rounded-2xl px-4 py-3 flex flex-col gap-1 min-w-0">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-[22px] font-semibold tabular-nums leading-tight">{value}</span>
      {pct != null && <span className="mt-1 block"><Gauge ratio={pct / 100} fill hi={pct > warnAbove} /></span>}
      {sub && <span className="text-[11px] text-faint tabular-nums truncate">{sub}</span>}
      {detail && <span className="text-[11px] text-faint truncate -mt-0.5" title={detail}>{detail}</span>}
    </div>
  )
}

type SortKey = 'name' | 'cpu' | 'mem' | 'disk'

function storageGet(k: string) { try { return localStorage.getItem(k) } catch { return null } }
function storageSet(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* 저장 불가 환경 */ } }

// 서버를 누르면 가운데에 나오는 화면: 리소스 사용량과 서비스 목록
export function ServerDashboard({ server, onOpen, onEdit }: { server: ServerWithServices; onOpen: (id: number) => void; onEdit?: () => void }) {
  const [onlyRunning, setOnlyRunning] = useState(() => storageGet('mb:onlyRunning') === '1')
  const m = server.metrics || {}

  // 차트 기록은 이 화면이 열려 있고, 탭이 보이고, 서버가 연결돼 있을 때만 5초마다 받는다 (오프라인이면 차트를 그리지 않는다)
  const points = usePoints(server.id, (since) => api.serverMetrics(server.id, since), 5000, server.online) as Point[]

  const toggle = () => setOnlyRunning((v) => { storageSet('mb:onlyRunning', v ? '0' : '1'); return !v })
  const isOff = (v: ServiceItem) => summarize(v.status)?.tone === 'off'
  const shown = server.services.filter((v) => !onlyRunning || !isOff(v))
  const hidden = server.services.length - shown.length
  const running = server.services.filter((v) => summarize(v.status)?.tone === 'ok').length
  // 정렬: 이름순이 기본. 이름순은 값이 바뀌어도 카드가 움직이지 않는다
  const [sortBy, setSortBy] = useState<SortKey>(() => {
    const v = storageGet('mb:sort'); return v === 'cpu' || v === 'mem' || v === 'disk' ? v : 'name'
  })
  const pickSort = (k: SortKey) => { setSortBy(k); storageSet('mb:sort', k) }
  const withUsage = server.services.filter((v) => v.status?.usage)
  const topCpu = Math.max(0.01, ...withUsage.map((v) => v.status!.usage!.cpu))
  const topMem = Math.max(1, ...withUsage.map((v) => v.status!.usage!.mem))
  const topDisk = Math.max(1, ...server.services.map((v) => v.disk ?? 0))
  const valueOf = (v: ServiceItem, k: SortKey) => (k === 'disk' ? v.disk : k === 'name' ? null : v.status?.usage?.[k]) ?? -1
  const sorted = [...shown].sort((a, b) => {
    if (sortBy !== 'name') {
      const d = valueOf(b, sortBy) - valueOf(a, sortBy)
      if (d) return d
    }
    return a.name.localeCompare(b.name)
  })

  return (
    <div className="flex-1 min-w-0 overflow-auto scroll-thin bg-bg">
      <div className="max-w-[1200px] mx-auto px-4 lg:px-6 py-5 flex flex-col gap-5">
        <section className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <h1 className="text-[20px] font-semibold font-mono">{server.id}</h1>
          <span className={`inline-flex items-center gap-1.5 text-[12px] px-2 py-0.5 rounded-full ${server.online ? 'bg-ok/10 text-ok' : 'bg-hover text-muted'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${server.online ? 'bg-ok' : 'bg-faint'}`} />{server.online ? '연결됨' : '오프라인'}
          </span>
          <span className="text-[12px] text-muted">
            {[server.hostname, m.uptime ? `가동 ${uptime(m.uptime)}` : '', server.version ? `에이전트 ${server.version}` : ''].filter(Boolean).join(' · ')}
          </span>
          <span className="ml-auto flex items-center gap-2">
          {onEdit && !server.pending && (
            <button type="button" onClick={onEdit} title="서비스 폴더·쿠버네티스 설정을 바꾸거나 에이전트를 최신으로 업데이트합니다"
              className="inline-flex h-8 items-center gap-1.5 px-3.5 rounded-full bg-panel text-[13px] text-muted hover:text-fg [box-shadow:var(--card-shadow)]">
              <Icon name="edit" size={13} sw={2} />편집
            </button>
          )}
          {server.beszel_url && (
            <a href={server.beszel_url} target="_blank" rel="noopener noreferrer" title="Beszel에서 이 서버의 상태 보기"
              className="inline-flex h-8 items-center gap-1.5 px-3.5 rounded-full bg-panel text-[13px] text-muted hover:text-fg [box-shadow:var(--card-shadow)]">
              Beszel<Icon name="external" size={13} sw={2} />
            </a>
          )}
          </span>
        </section>

        {server.online ? <>
          <section className="grid grid-cols-2 md:grid-cols-4 gap-3" aria-label="현재 리소스">
            <Stat label="CPU" value={`${m.cpu ?? '-'}%`} pct={m.cpu} sub={cpuSpec(m)} detail={m.cpu_model} />
            <Stat label="메모리" value={`${m.ram ?? '-'}%`} pct={m.ram} sub={`${fmtBytes(m.mem_used)} / ${fmtBytes(m.mem_total)}`} />
            <Stat label="디스크" value={`${m.disk ?? '-'}%`} pct={m.disk} sub={`${fmtBytes(m.disk_used)} / ${fmtBytes(m.disk_total)}`} />
            <Stat label="서비스" value={`${running} / ${server.services.length}`} sub="실행 중 / 전체"
              pct={server.services.length ? (running / server.services.length) * 100 : 0} warnAbove={100} />
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-3 gap-3" aria-label="리소스 추이">
            <TimeChart title="CPU" unit="pct" minMax={20} points={points} series={[{ key: 'cpu', label: 'CPU', color: S1 }]} />
            <TimeChart title="메모리" unit="pct" fixedMax={100} points={points} series={[{ key: 'ram', label: '메모리', color: S1 }]} />
            <TimeChart title="디스크" unit="pct" fixedMax={100} points={points} series={[{ key: 'disk', label: '디스크', color: S1 }]} />
          </section>
        </> : (
          <p className="text-[13px] text-muted bg-panel border border-line rounded-2xl px-4 py-3">
            {server.pending ? '아직 연결된 적이 없습니다. 추가할 서버에서 설치 명령어를 실행하세요.' : '오프라인이라 리소스를 볼 수 없습니다.'}
          </p>
        )}

        <section className="flex flex-col gap-3" aria-label="서비스">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-[15px] font-semibold mr-auto">서비스 <span className="text-faint font-normal tabular-nums">{server.services.length}</span></h2>
            <div role="radiogroup" aria-label="정렬" className="flex gap-0.5 p-0.5 rounded-full bg-hover text-[12px]">
              {([['name', '이름'], ['cpu', 'CPU'], ['mem', '메모리'], ['disk', '디스크']] as const).map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={sortBy === k} onClick={() => pickSort(k)}
                  className={`h-7 px-3 rounded-full ${sortBy === k ? 'bg-accent text-onaccent font-semibold' : 'text-muted hover:text-fg'}`}>{label}</button>
              ))}
            </div>
            <button type="button" role="switch" aria-checked={onlyRunning} onClick={toggle}
              className={`text-[12px] h-8 px-3 rounded-full inline-flex items-center gap-1.5 ${onlyRunning ? 'text-accent bg-accentsoft' : 'text-muted hover:text-fg hover:bg-hover'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${onlyRunning ? 'bg-ok' : 'bg-faint'}`} />실행 중만{hidden ? ` · ${hidden}개 숨김` : ''}
            </button>
          </div>
          {server.services.length === 0 ? (
            <p className="text-[13px] text-muted bg-panel border border-line rounded-2xl px-4 py-3">
              서비스 폴더가 비어 있습니다. 에이전트가 보는 폴더 아래에 서비스 폴더가 있는지 확인하세요.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {sorted.map((v) => {
                const st = summarize(v.status)
                const u = v.status?.usage
                return (
                  <button key={v.id} type="button" onClick={() => onOpen(v.id)}
                    className={`text-left bg-panel border border-line rounded-2xl px-4 py-3 hover:border-edge flex flex-col gap-2.5 min-w-0 ${st?.tone === 'off' ? 'opacity-50 hover:opacity-100' : ''}`}>
                    <span className="flex items-center gap-2 min-w-0">
                      <StatusDot status={v.status} />
                      <span className="font-mono font-semibold text-[13.5px] truncate">{v.name}</span>
                      {st && <span className="ml-auto text-[12px] text-muted whitespace-nowrap">{st.label}</span>}
                    </span>
                    {u || v.disk != null ? (
                      <span className="flex flex-col gap-1">
                        <GaugeRow valueCh={8} label="cpu" value={u ? `${u.cpu < 10 ? u.cpu.toFixed(1) : Math.round(u.cpu)}%` : '-'} ratio={u ? u.cpu / topCpu : 0} />
                        <GaugeRow valueCh={8} label="mem" value={u ? fmtBytes(u.mem) : '-'} ratio={u ? u.mem / topMem : 0} />
                        <GaugeRow valueCh={8} label="disk" value={v.disk != null ? fmtBytes(v.disk) : '-'} ratio={(v.disk ?? 0) / topDisk} />
                      </span>
                    ) : (
                      <span className="text-[12px] text-faint">{st ? '실행 중인 컨테이너 없음' : 'compose 서비스 아님'}</span>
                    )}
                    <span className="text-[12px] text-faint flex items-center gap-2 min-w-0">
                      <Icon name="layers" size={13} sw={1.8} className="flex-none" />
                      <span className="font-mono truncate text-path">{v.path.split('/').slice(-2).join('/')}</span>
                      <span className="ml-auto whitespace-nowrap">
                        {v.sync_error ? <span className="text-fail">Makefile 오류</span> : v.node_count ? `명령어 ${v.node_count}개` : 'Makefile 없음'}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
          {(withUsage.length > 0 || server.services.some((v) => v.disk != null)) && <p className="text-[11px] text-faint">CPU는 서버 전체 대비입니다. 막대는 이 서버에서 가장 많이 쓰는 서비스를 기준으로 한 비교입니다. CPU·메모리는 15초, 디스크(서비스 폴더 크기)는 5분마다 갱신됩니다.</p>}
        </section>
      </div>
    </div>
  )
}
