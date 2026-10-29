import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Logo } from '../icons'

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api.login(username.trim(), password); onDone() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="min-h-full grid place-items-center p-4 viewport cursor-default">
      <form onSubmit={submit} className="w-full max-w-[380px] bg-panel border border-line rounded-2xl shadow-xl p-7 flex flex-col gap-5">
        <div className="flex items-center gap-2.5"><Logo /><span className="font-semibold text-[16px]">Makeboard</span></div>
        <div>
          <h1 className="text-[18px] font-semibold">로그인</h1>
          <p className="text-[13px] text-muted mt-1">계정이 없으면 관리자에게 요청하세요.</p>
        </div>
        <label className="flex flex-col gap-1.5 text-[12px] text-muted">아이디
          <input id="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="off"
            className="h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none font-mono text-[14px] text-fg" />
        </label>
        <label className="flex flex-col gap-1.5 text-[12px] text-muted">비밀번호
          <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password"
            className="h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none font-mono text-[14px] text-fg" />
        </label>
        {error && <p role="alert" className="text-[13px] text-fail -mt-2">{error}</p>}
        <button type="submit" disabled={busy || !username.trim() || !password} className="h-10 rounded-full bg-accent text-onaccent text-[14px] font-medium hover:brightness-110 disabled:opacity-50">
          {busy ? '확인 중…' : '로그인'}
        </button>
      </form>
    </div>
  )
}
