import { useState } from 'react'
import { CopyBox } from './CopyBox'
import { Icon } from '../icons'
import type { ServiceDetail } from '../types'

export function SourceModal({ service, onSync, onClose }: { service: ServiceDetail; onSync: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const sync = async () => {
    setBusy(true); setNote('')
    try { await onSync(); setNote('서버에서 다시 불러왔습니다') } catch (e) { setNote((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <h3 id="mTitle" className="text-[17px] font-semibold">Makefile</h3>
          <p className="text-[13px] text-muted mt-1"><span className="font-mono">{service.server?.id}:{service.path}/Makefile</span>
            {service.synced_at && <> · {new Date(service.synced_at).toLocaleString('ko-KR')} 동기화</>}</p>
        </div>
        <button type="button" onClick={sync} disabled={busy} className="h-8 px-3 rounded-full border border-line text-[12px] hover:bg-hover inline-flex items-center gap-1.5 disabled:opacity-50">
          <Icon name="refresh" size={14} />다시 불러오기</button>
      </div>
      {service.sync_error && <p className="text-[13px] text-fail">{service.sync_error}</p>}
      <CopyBox text={service.makefile}>
      <pre title="웹에서 저장하면 이전 내용은 서버의 Makefile.makeboard.bak 에 남습니다" className="rounded-xl bg-hover p-4 pr-14 text-[12px] leading-relaxed font-mono whitespace-pre overflow-auto scroll-thin max-h-[460px]">{service.makefile || '(비어 있음)'}</pre>
      </CopyBox>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-faint">{note}</span>
        <button type="button" onClick={onClose} className="h-9 px-4 rounded-full text-[13px] text-muted hover:bg-hover">닫기</button>
      </div>
    </div>
  )
}
