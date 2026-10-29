import { useRef, useState } from 'react'
import { api } from '../api'
import type { ServerWithServices } from '../types'

const MANUAL = 'docker rm -f makeboard-agent && docker rmi makeboard-agent'

export function DeleteServer({ server, onDone, onClose }: { server: ServerWithServices; onDone: (message: string) => void; onClose: () => void }) {
  // 에이전트까지 지울지는 관리자가 고른다
  const [withAgent, setWithAgent] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // 에이전트를 자동으로 못 지웠을 때 보여줄 결과
  const [leftover, setLeftover] = useState<string | null>(null)
  const pre = useRef<HTMLPreElement>(null)

  const copy = async () => {
    try { await navigator.clipboard.writeText(MANUAL); setNote('복사했습니다') } catch {
      const r = document.createRange(); r.selectNodeContents(pre.current!)
      const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); setNote('선택했습니다. Ctrl+C로 복사하세요')
    }
  }

  const remove = async () => {
    setBusy(true); setError('')
    const uninstall = withAgent && !server.pending
    try {
      const r = await api.deleteServer(server.id, uninstall)
      if (!uninstall || r.agent.result === 'removed') {
        onDone(`${server.id} 서버를 삭제했습니다.${uninstall ? ` ${r.agent.message}` : ''}`)
      } else {
        setLeftover(r.agent.message); setBusy(false)
      }
    } catch (e) { setError((e as Error).message); setBusy(false) }
  }

  const manualBox = (
    <>
      <pre ref={pre} className="rounded-xl bg-hover p-4 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-all">{MANUAL}</pre>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-faint">{note}</span>
        <button type="button" onClick={copy} className="h-8 px-3 rounded-full border border-line text-[12px] hover:bg-hover">복사</button>
      </div>
    </>
  )

  if (leftover) {
    return (
      <div className="p-6 flex flex-col gap-4">
        <div>
          <h3 id="mTitle" className="text-[17px] font-semibold">서버를 삭제했습니다</h3>
          <p className="text-[13px] text-muted mt-1">화면에서 지우고 토큰을 무효로 했습니다. 다만 에이전트는 자동으로 지우지 못했습니다.</p>
        </div>
        <p className="text-[13px] rounded-xl bg-warn/10 text-warn px-3 py-2">{leftover}</p>
        <p className="text-[13px] text-muted">그 서버에서 아래 명령어로 에이전트 컨테이너를 지우세요.</p>
        {manualBox}
        <div className="flex justify-end">
          <button type="button" onClick={() => onDone(`${server.id} 서버를 삭제했습니다`)} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px]">닫기</button>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 flex flex-col gap-4">
      <div>
        <h3 id="mTitle" className="text-[17px] font-semibold">서버 삭제</h3>
        <p className="text-[13px] text-muted mt-1">
          {server.pending
            ? <><span className="font-mono text-fg">{server.id}</span> 는 아직 연결된 적이 없습니다. 지우면 발급한 설치 명령어가 무효가 됩니다.</>
            : <><span className="font-mono text-fg">{server.id}</span> 와 서비스 {server.services.length}개, 실행 기록을 지우고 토큰을 무효로 합니다. 서비스 폴더와 Makefile은 그대로 남습니다.</>}
        </p>
      </div>

      {!server.pending && (
        <label className="flex items-start gap-3 rounded-xl border border-line px-4 py-3 cursor-pointer hover:bg-hover">
          <input type="checkbox" checked={withAgent} onChange={(e) => setWithAgent(e.target.checked)} className="mt-0.5 w-4 h-4 accent-[rgb(var(--accent))]" />
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium">서버 에이전트도 삭제</span>
            <span className="text-[12px] text-muted">
              {server.online
                ? '그 서버의 makeboard-agent 컨테이너를 자동으로 지웁니다.'
                : '오프라인이라 자동으로 지울 수 없습니다. 삭제 후 직접 지우는 명령어를 보여드립니다.'}
            </span>
          </span>
        </label>
      )}
      {!server.pending && !withAgent && (
        <p className="text-[12px] text-faint -mt-2">에이전트는 계속 돌면서 접속을 시도하지만, 토큰이 무효라 연결되지 않습니다.</p>
      )}

      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 px-4 rounded-full text-[13px] text-muted hover:bg-hover">취소</button>
        <button type="button" onClick={remove} disabled={busy} className="h-9 px-4 rounded-full bg-fail text-onaccent text-[13px] disabled:opacity-50">
          {busy ? (withAgent && server.online ? '에이전트 지우는 중…' : '삭제하는 중…') : '삭제'}</button>
      </div>
    </div>
  )
}
