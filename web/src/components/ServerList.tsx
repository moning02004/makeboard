import { Icon } from '../icons'
import type { ServerWithServices } from '../types'
import { GaugeRow } from './Gauge'
import { summarize } from './ServiceStatus'

// 첫 화면: 모든 서버를 카드로 보여준다
export function ServerList({ servers, onOpen, onAdd }: { servers: ServerWithServices[]; onOpen: (id: string) => void; onAdd?: () => void }) {
  const connected = servers.filter((s) => !s.pending)
  const pending = servers.filter((s) => s.pending)
  return (
    <div className="flex-1 min-w-0 overflow-auto scroll-thin bg-bg">
      <div className="max-w-[1200px] mx-auto px-4 lg:px-6 py-5 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <h1 className="text-[18px] font-semibold">서버 <span className="text-faint font-normal tabular-nums">{connected.length}</span></h1>
          {onAdd && <button type="button" onClick={onAdd} className="ml-auto h-8 px-4 rounded-full bg-accent text-onaccent text-[13px] font-semibold inline-flex items-center gap-1.5"><Icon name="plus" size={14} sw={2.4} />서버 추가</button>}
        </div>
        {connected.length === 0 && (
          <p className="text-[13px] text-muted bg-panel border border-line rounded-2xl px-4 py-3">연결된 서버가 없습니다. '+ 서버 추가'로 설치 명령어를 만드세요.</p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {connected.map((s) => {
            const m = s.metrics || {}
            const withStatus = s.services.filter((v) => v.status)
            const running = withStatus.filter((v) => summarize(v.status)?.tone === 'ok').length
            const warn = withStatus.filter((v) => ['warn', 'err'].includes(summarize(v.status)?.tone ?? '')).length
            const off = withStatus.filter((v) => summarize(v.status)?.tone === 'off').length
            return (
              <button key={s.id} type="button" onClick={() => onOpen(s.id)}
                className={`text-left bg-panel border border-line rounded-2xl p-4 hover:border-edge flex flex-col gap-3 ${s.online ? '' : 'opacity-60'}`}>
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-full flex-none ${s.online ? 'bg-ok' : 'bg-faint'}`} />
                  <span className="font-mono text-[14px] font-semibold truncate">{s.id}</span>
                  <span className="ml-auto text-[12px] text-muted whitespace-nowrap">{s.online ? '연결됨' : '오프라인'}</span>
                </span>
                {s.online
                  ? <span className="flex flex-col gap-1">
                      <GaugeRow valueCh={4} label="cpu" ratio={(m.cpu ?? 0) / 100} value={m.cpu == null ? '-' : `${m.cpu}%`} hi={(m.cpu ?? 0) > 85} />
                      <GaugeRow valueCh={4} label="mem" ratio={(m.ram ?? 0) / 100} value={m.ram == null ? '-' : `${m.ram}%`} hi={(m.ram ?? 0) > 85} />
                      <GaugeRow valueCh={4} label="disk" ratio={(m.disk ?? 0) / 100} value={m.disk == null ? '-' : `${m.disk}%`} hi={(m.disk ?? 0) > 85} />
                    </span>
                  : <span className="text-[12px] text-faint">리소스 정보 없음</span>}
                <span className="text-[12px] text-muted flex items-center gap-2 flex-wrap">
                  <span>서비스 {s.services.length}개</span>
                  {withStatus.length > 0 && <>
                    <span className="text-faint">·</span>
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-ok" />실행 {running}</span>
                    {warn > 0 && <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-warn" />이상 {warn}</span>}
                    <span className="inline-flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-faint" />중지 {off}</span>
                  </>}
                </span>
              </button>
            )
          })}
        </div>
        {pending.length > 0 && (
          <p className="text-[12px] text-faint">연결 대기 중: <span className="font-mono">{pending.map((s) => s.id).join(', ')}</span></p>
        )}
      </div>
    </div>
  )
}
