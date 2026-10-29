import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Logo } from '../icons'

export function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api.login(token.trim()); onDone() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="min-h-full grid place-items-center p-4 viewport cursor-default">
      <form onSubmit={submit} className="w-full max-w-[380px] bg-panel border border-line rounded-2xl shadow-xl p-7 flex flex-col gap-5">
        <div className="flex items-center gap-2.5"><Logo /><span className="font-semibold text-[16px]">Makeboard</span></div>
        <div>
          <h1 className="text-[18px] font-semibold">로그인</h1>
          <p className="text-[13px] text-muted mt-1">서버의 <span className="font-mono">MAKEBOARD_ADMIN_TOKEN</span> 값을 입력하세요.</p>
        </div>
        <label className="flex flex-col gap-1.5 text-[12px] text-muted">관리자 토큰
          <input id="token" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} autoComplete="current-password"
            className="h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none font-mono text-[14px] text-fg" />
        </label>
        {error && <p role="alert" className="text-[13px] text-fail -mt-2">{error}</p>}
        <button type="submit" disabled={busy || !token.trim()} className="h-10 rounded-full bg-accent text-onaccent text-[14px] font-medium hover:brightness-110 disabled:opacity-50">
          {busy ? '확인 중…' : '로그인'}
        </button>
      </form>
    </div>
  )
}
