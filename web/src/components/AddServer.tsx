import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../api'
import type { ServerWithServices } from '../types'

const inp = 'w-full h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none text-[14px] text-fg'

// 개발 중(vite 5173)에는 API 서버 포트(8000)를 기본값으로 쓴다
export function guessUrl(): string {
  return location.port === '5173' ? `${location.protocol}//${location.hostname}:8000` : location.origin
}

function Toggle({ on, onChange, label, hint }: { on: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)}
      className="flex items-center gap-3 text-left rounded-xl border border-line px-3.5 py-2.5 hover:bg-hover">
      <span className={`relative w-9 h-5 rounded-full flex-none transition-colors ${on ? 'bg-accent' : 'bg-line'}`}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-[left] ${on ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{label}</span>
        <span className="block text-[12px] text-muted">{hint}</span>
      </span>
    </button>
  )
}

/** 서버 추가와 편집. 편집은 저장된 설치 값을 채워 보여 주고, 바꾼 값으로 그 서버에서 실행할 명령어를 새로 만든다. */
export function AddServer({ servers, edit, onClose }: { servers: ServerWithServices[]; edit?: ServerWithServices; onClose: () => void }) {
  const [name, setName] = useState(edit?.id ?? '')
  const [scan, setScan] = useState(edit ? '' : '/home/ubuntu/services')
  const [k8s, setK8s] = useState(false)
  const [kubeconfig, setKubeconfig] = useState('')
  // 화면에 묻지 않는 값: 실행 계정은 저장된 값을 그대로 넘기고(없으면 서비스 폴더 소유자), 주소는 설정 값을 쓴다
  const [runAs, setRunAs] = useState('')
  const [url, setUrl] = useState('')
  const [loaded, setLoaded] = useState(!edit)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ agent_id: string; command: string } | null>(null)
  const [note, setNote] = useState('')
  const pre = useRef<HTMLPreElement>(null)

  useEffect(() => {
    api.agentConfig().then((c) => setUrl(c.public_url || guessUrl())).catch(() => setUrl(guessUrl()))
  }, [])
  useEffect(() => {
    if (!edit) return
    api.installOptions(edit.id).then((o) => {
      setScan(o.scan.join(', ')); setK8s(!!o.kubeconfig); setKubeconfig(o.kubeconfig); setRunAs(o.run_as); setLoaded(true)
    }).catch((e) => setError((e as Error).message))
  }, [edit])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      setResult(await api.addAgent({ name: name.trim(), environment: edit?.environment || 'prod', run_as: runAs, public_url: url,
        scan: scan.split(',').map((s) => s.trim()).filter(Boolean), kubeconfig: k8s ? kubeconfig.trim() : '', replace: !!edit }))
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
          <h3 id="mTitle" className="text-[17px] font-semibold">{edit ? '바꾼 설정 적용하기' : '설치 명령어'}</h3>
          <p className="text-[13px] text-muted mt-1">{edit
            ? <><span className="font-mono">{result.agent_id}</span> 에서 실행하면 적용되고, 에이전트도 최신이 됩니다.</>
            : '추가할 서버의 터미널에 붙여넣으세요 (Docker 필요).'}</p>
        </div>
        <pre ref={pre} className="rounded-xl bg-hover p-4 text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-all">{result.command}</pre>
        <p className="text-[12px] text-faint">토큰이 들어 있어 지금만 볼 수 있습니다.</p>
        <div className="flex items-center gap-2.5 rounded-xl border border-line px-4 py-3 text-[13px]">
          <span className={`w-2 h-2 rounded-full flex-none ${online ? 'bg-ok' : 'bg-faint animate-pulse'}`} />
          {edit
            ? <span className={online ? '' : 'text-muted'}><span className="font-mono">{result.agent_id}</span> {online ? '연결됨' : '다시 연결을 기다리는 중…'} · 에이전트 {srv?.version || '-'}</span>
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
        <h3 id="mTitle" className="text-[17px] font-semibold">{edit ? <>서버 편집 <span className="font-mono text-muted font-normal">{edit.id}</span></> : '서버 추가'}</h3>
        <p className="text-[13px] text-muted mt-1">{edit
          ? '저장 후 나오는 명령어를 그 서버에서 실행하세요.'
          : '설치 명령어를 만듭니다.'}</p>
      </div>
      {!edit && <label className="flex flex-col gap-1.5 text-[12px] text-muted">서버 이름
        <input className={`${inp} font-mono`} value={name} onChange={(e) => setName(e.target.value)} autoFocus autoComplete="off" spellCheck={false} placeholder="server-105" />
      </label>}
      <label className="flex flex-col gap-1.5 text-[12px] text-muted">서비스 폴더 <span className="text-faint">하위 폴더가 각각 서비스 · 여러 개는 쉼표로</span>
        <input className={`${inp} font-mono`} value={scan} onChange={(e) => setScan(e.target.value)} autoComplete="off" spellCheck={false}
          placeholder={loaded ? '/home/ubuntu/services' : '불러오는 중…'} disabled={!loaded} />
      </label>
      <div className="flex flex-col gap-2">
        <Toggle on={k8s} onChange={setK8s} label="쿠버네티스 사용" hint="kubectl 로 배포하는 서버 (k3s 등)" />
        {k8s && (
          <label className="flex flex-col gap-1.5 text-[12px] text-muted">kubeconfig 경로 <span className="text-faint">서비스 폴더 소유자가 읽을 수 있는 파일</span>
            <input className={`${inp} font-mono`} value={kubeconfig} onChange={(e) => setKubeconfig(e.target.value)} autoFocus autoComplete="off" spellCheck={false} placeholder="/home/ubuntu/.kube/config" />
          </label>
        )}
      </div>
      <p className="text-[12px] text-faint" title="설정에서 바꿀 수 있습니다">접속 주소 <span className="font-mono">{url || '…'}</span></p>
      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 px-4 rounded-full text-[13px] text-muted hover:bg-hover">취소</button>
        <button type="submit" disabled={busy || !loaded || !name.trim() || !scan.trim() || !url || (k8s && !kubeconfig.trim())}
          className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] disabled:opacity-50">
          {busy ? '만드는 중…' : edit ? '저장하고 명령어 만들기' : '명령어 만들기'}</button>
      </div>
    </form>
  )
}
