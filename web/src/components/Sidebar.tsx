import { Icon, Logo } from '../icons'
import type { ServerWithServices } from '../types'
import { GaugeRow } from './Gauge'

function ago(iso: string | null): string {
  if (!iso) return '연결 기록 없음'
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return '방금 전'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  return `${Math.floor(s / 86400)}일 전`
}

export function Sidebar({ servers, current, disabled, open, onClose, onPick, onHelp, onDelete, onEdit }: {
  servers: ServerWithServices[]
  open: boolean
  onClose: () => void
  current: string | null
  disabled: boolean
  onPick: (id: string) => void
  // 관리자가 아니면 넘기지 않아 버튼을 숨긴다
  onHelp?: () => void
  onDelete?: (server: ServerWithServices) => void
  onEdit?: (server: ServerWithServices) => void
}) {
  const connected = servers.filter((s) => !s.pending)
  const pending = servers.filter((s) => s.pending)
  // 모바일: 왼쪽에서 펼쳐지는 패널, 데스크톱(lg 이상): 항상 보이는 사이드바
  return (<>
    <div className={`fixed inset-0 z-40 bg-black/40 lg:hidden transition-opacity ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onClick={onClose} aria-hidden="true" />
    <aside className={`fixed inset-y-0 left-0 z-50 w-[280px] max-w-[85vw] transition-transform lg:static lg:z-auto lg:translate-x-0 lg:transition-none lg:h-full flex-none bg-bg p-3.5 flex flex-col gap-3 ${open ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}`}
      aria-label="서버 목록">
      <div className="h-10 flex items-center gap-2.5 px-2 flex-none">
        <Logo /><span className="font-semibold text-[15px]">Makeboard</span>
        <button type="button" onClick={onClose} aria-label="닫기" className="ml-auto -mr-1 w-8 h-8 grid place-items-center rounded-full text-faint hover:text-fg hover:bg-panel lg:hidden">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div className="flex-1 min-h-0 rounded-2xl bg-panel border border-line flex flex-col overflow-hidden">
      <div className="px-3 pt-3.5 pb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-faint px-2">서버</span>
        {onHelp && <button type="button" onClick={onHelp} className="text-xs font-semibold text-accent bg-accentsoft hover:brightness-95 px-3 py-1.5 rounded-full">+ 서버 추가</button>}
      </div>
      <nav className="flex-1 overflow-auto scroll-thin px-2.5 pb-3 flex flex-col gap-1" aria-label="서버">
        {connected.length === 0 && (
          <p className="text-[13px] text-faint px-2 py-3 leading-relaxed">연결된 서버가 없습니다. {onHelp ? "위의 '+ 서버 추가'로 설치 명령어를 만드세요." : '관리자에게 서버 추가를 요청하세요.'}</p>
        )}
        {connected.map((s) => (
          <div key={s.id} className="relative group flex-none">
            <button type="button" disabled={disabled} onClick={() => onPick(s.id)} aria-current={s.id === current ? 'page' : undefined}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2.5 rounded-xl text-left ${s.id === current ? 'bg-accentsoft' : 'hover:bg-hover'} ${s.online ? '' : 'opacity-60'}`}>
              <span className={`w-2 h-2 rounded-full flex-none ${s.online ? 'bg-ok' : 'bg-faint'}`} />
              <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                  <span className={`font-mono text-[13px] font-medium truncate ${s.id === current ? 'text-accent' : ''}`}>{s.id}</span>
                  {s.environment !== 'prod' && <span className="text-[10px] font-semibold px-1.5 py-px rounded bg-ok/10 text-ok">
                    {s.environment === 'staging' ? '스테이징' : '개발'}
                  </span>}
                  <span className={`ml-auto text-[11px] text-faint tabular-nums ${onEdit ? 'pr-14' : onDelete ? 'pr-7' : ''}`}>{s.services.length}</span>
                </span>
                {s.online
                  ? <span className="mt-1.5 flex flex-col gap-1">
                      <GaugeRow valueCh={4} label="cpu" ratio={(s.metrics?.cpu ?? 0) / 100} value={s.metrics?.cpu == null ? '-' : `${s.metrics.cpu}%`} hi={(s.metrics?.cpu ?? 0) > 85} />
                      <GaugeRow valueCh={4} label="ram" ratio={(s.metrics?.ram ?? 0) / 100} value={s.metrics?.ram == null ? '-' : `${s.metrics.ram}%`} hi={(s.metrics?.ram ?? 0) > 85} />
                      <GaugeRow valueCh={4} label="disk" ratio={(s.metrics?.disk ?? 0) / 100} value={s.metrics?.disk == null ? '-' : `${s.metrics.disk}%`} hi={(s.metrics?.disk ?? 0) > 85} />
                    </span>
                  : <span className="block text-[11px] text-faint mt-0.5">오프라인 · {ago(s.last_seen)}</span>}
              </span>
            </button>
            {(onEdit || onDelete) && <span className="absolute right-1.5 top-1.5 flex lg:opacity-0 lg:group-hover:opacity-100 focus-within:opacity-100">
              {onEdit && <button type="button" onClick={() => onEdit(s)} aria-label={`${s.id} 서버 편집`} title="서버 편집"
                className="w-7 h-7 grid place-items-center rounded-full text-faint hover:text-fg hover:bg-panel">
                <Icon name="edit" size={14} />
              </button>}
              {onDelete && <button type="button" onClick={() => onDelete(s)} aria-label={`${s.id} 서버 삭제`} title="서버 삭제"
                className="w-7 h-7 grid place-items-center rounded-full text-faint hover:text-fail hover:bg-panel">
                <Icon name="trash" size={14} />
              </button>}
            </span>}
          </div>
        ))}
      </nav>
      {pending.length > 0 && (
        <section aria-label="연결 대기 중인 서버" className="flex-none mx-2.5 mb-2.5 rounded-xl bg-hover px-1.5 py-2">
          <p className="text-xs font-medium text-faint px-2 pb-1.5">연결 대기 중</p>
          {pending.map((s) => (
            <div key={s.id} className="group flex items-center gap-2.5 px-2 h-8 rounded-lg hover:bg-panel"
              title="추가할 서버에서 설치 명령어를 실행하면 위로 옮겨집니다">
              <span className="w-2 h-2 rounded-full flex-none border border-faint" />
              <span className="flex-1 min-w-0 font-mono text-[12px] text-muted truncate">{s.id}</span>
              {onDelete && <button type="button" onClick={() => onDelete(s)} aria-label={`${s.id} 삭제`} title="삭제"
                className="w-6 h-6 grid place-items-center rounded-full text-faint hover:text-fail lg:opacity-0 lg:group-hover:opacity-100 focus:opacity-100">
                <Icon name="trash" size={13} />
              </button>}
            </div>
          ))}
        </section>
      )}
      </div>
    </aside>
  </>)
}
