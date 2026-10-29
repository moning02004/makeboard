import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import type { ServerWithServices } from '../types'

const inp = 'w-full h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none text-[14px] text-fg'

// 개발 중(vite 5173)에는 API 서버 포트(8000)를 기본값으로 쓴다
export function guessUrl(): string {
  return location.port === '5173' ? `${location.protocol}//${location.hostname}:8000` : location.origin
}

/** 새 서버 추가. reinstall 을 주면 그 서버의 에이전트를 다시 설치하는 명령어를 만든다 (업데이트·옵션 변경). */
export function AddServer({ servers, reinstall, onClose }: { servers: ServerWithServices[]; reinstall?: ServerWithServices; onClose: () => void }) {
  const [name, setName] = useState(reinstall?.id ?? '')
  // 다시 설치할 때는 에이전트가 보고한 첫 서비스 폴더를 기본값으로 쓴다
  const [scan, setScan] = useState(reinstall?.metrics?.disk_path || '/home/ubuntu/services')
  const [runAs, setRunAs] = useState('')
  const [kubeconfig, setKubeconfig] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ agent_id: string; command: string } | null>(null)
  const [note, setNote] = useState('')
  const pre = useRef<HTMLPreElement>(null)

  useEffect(() => {
    api.agentConfig().then((c) => setUrl((u) => u || c.public_url || guessUrl())).catch(() => setUrl((u) => u || guessUrl()))
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      setResult(await api.addAgent({ name: name.trim(), environment: reinstall?.environment || 'prod', run_as: runAs.trim(), public_url: url.trim(),
        scan: scan.split(',').map((s) => s.trim()).filter(Boolean), kubeconfig: kubeconfig.trim(), replace: !!reinstall }))
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  const copy = async () => {
    if (!result) return
    try { await navigator.clipboard.writeText(result.command); setNote('복사했습니다') } catch {
      const r = document.createRange(); r.selectNodeContents(pre.current!)
      const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); setNote('선택했습니다. Ctrl+C로 복사하세요')
    }
  }

  if (result) {
    const srv = servers.find((s) => s.id === result.agent_id)
    const online = !!srv?.online
    return (
      <div className="p-6 flex flex-col gap-4">
        <div>
          <h3 id="mTitle" className="text-[17px] font-semibold">설치 명령어</h3>
          <p className="text-[13px] text-muted mt-1">추가할 서버의 터미널에 붙여넣으세요. 다시 실행하면 최신 에이전트로 업데이트됩니다.</p>
        </div>
        <p className="text-[12px] text-muted -mt-1">추가할 서버에 Docker 만 있으면 됩니다. 에이전트는 컨테이너로 돌고, 레시피의 docker / docker compose 는 그 서버의 Docker 를 그대로 씁니다.</p>
        <pre ref={pre} className="rounded-xl bg-hover p-4 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-all">{result.command}</pre>
        <p className="text-[12px] text-faint">토큰은 지금만 볼 수 있습니다. 필요하면 다른 이름으로 다시 추가하세요.</p>
        <div className="flex items-center gap-2.5 rounded-xl border border-line px-4 py-3 text-[13px]">
          <span className={`w-2 h-2 rounded-full flex-none ${online ? 'bg-ok' : 'bg-faint animate-pulse'}`} />
          {reinstall
            ? <span className={online ? '' : 'text-muted'}><span className="font-mono">{result.agent_id}</span> {online ? '연결됨' : '다시 연결을 기다리는 중…'} · 현재 에이전트 {srv?.version || '-'}</span>
            : online
            ? <span><span className="font-mono">{result.agent_id}</span> 연결됨 · 서비스 {srv?.services.length ?? 0}개</span>
            : <span className="text-muted"><span className="font-mono">{result.agent_id}</span> 연결을 기다리는 중…</span>}
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[12px] text-faint">{note}</span>
          <div className="flex gap-2">
            <button type="button" onClick={copy} className="h-9 px-4 rounded-full border border-line text-[13px] hover:bg-hover">복사</button>
            <button type="button" onClick={onClose} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px]">{online ? '완료' : '닫기'}</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="p-6 flex flex-col gap-4">
      <div>
        <h3 id="mTitle" className="text-[17px] font-semibold">{reinstall ? '에이전트 다시 설치' : '서버 추가'}</h3>
        <p className="text-[13px] text-muted mt-1">{reinstall
          ? <>새 설치 명령어를 만듭니다. <span className="font-mono">{reinstall.id}</span> 에서 실행하면 최신 에이전트로 바뀝니다. 이전 명령어의 토큰은 더 이상 쓸 수 없습니다.</>
          : '설치 명령어 한 줄을 만들어 드립니다. 서비스 폴더 바로 아래 폴더는 모두 서비스가 됩니다. Makefile 이 없으면 웹에서 만들 수 있습니다.'}</p>
      </div>
      {!reinstall && <label className="flex flex-col gap-1.5 text-[12px] text-muted">서버 이름
        <input className={`${inp} font-mono`} value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" spellCheck={false} placeholder="server-105" />
      </label>}
      <label className="flex flex-col gap-1.5 text-[12px] text-muted">서비스 폴더 <span className="text-faint">여러 개는 쉼표로 구분</span>
        <input className={`${inp} font-mono`} value={scan} onChange={(e) => setScan(e.target.value)} autoComplete="off" spellCheck={false} placeholder="/home/ubuntu/services" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-muted">실행 계정 <span className="text-faint">레시피가 이 계정 권한으로 실행되고, 만드는 파일도 이 계정 소유가 됩니다</span>
        <input className={`${inp} font-mono`} value={runAs} onChange={(e) => setRunAs(e.target.value)} autoComplete="off" spellCheck={false} placeholder="비우면 서비스 폴더의 소유자 (root 로 돌리려면 root)" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-muted">kubeconfig <span className="text-faint">쿠버네티스(k3s 등)를 쓰는 서버만. 실행 계정이 읽을 수 있는 파일이어야 합니다</span>
        <input className={`${inp} font-mono`} value={kubeconfig} onChange={(e) => setKubeconfig(e.target.value)} autoComplete="off" spellCheck={false} placeholder="비우면 연결하지 않음 (예: /home/ubuntu/.kube/config)" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-muted">이 Makeboard 서버 주소 <span className="text-faint">추가할 서버에서 접속할 수 있는 주소</span>
        <input className={`${inp} font-mono`} value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" spellCheck={false} placeholder="http://192.168.0.4:8000" />
      </label>
      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 px-4 rounded-full text-[13px] text-muted hover:bg-hover">취소</button>
        <button type="submit" disabled={busy || !name.trim() || !url.trim()} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] disabled:opacity-50">
          {busy ? '만드는 중…' : '명령어 만들기'}</button>
      </div>
    </form>
  )
}
