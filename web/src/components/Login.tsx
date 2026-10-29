import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { Logo } from '../icons'

const field = 'h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none font-mono text-[14px] text-fg'

/** 아이디·비밀번호, 2단계 인증을 켠 계정이면 이어서 인증 앱의 6자리 코드(또는 복구 코드) */
export function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [ticket, setTicket] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (ticket) {
        await api.loginOtp(ticket, code.trim())
        onDone()
      } else {
        const r = await api.login(username.trim(), password)
        if (r.otp_required && r.ticket) { setTicket(r.ticket); setCode('') } else onDone()
      }
    } catch (err) {
      setError((err as Error).message)
      if (ticket && /시간이 지났/.test((err as Error).message)) setTicket(null)
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-full grid place-items-center p-4 viewport cursor-default">
      <form onSubmit={submit} className="w-full max-w-[380px] bg-panel border border-line rounded-2xl shadow-xl p-7 flex flex-col gap-5">
        <div className="flex items-center gap-2.5"><Logo /><span className="font-semibold text-[16px]">Makeboard</span></div>
        {ticket ? <>
          <div>
            <h1 className="text-[18px] font-semibold">2단계 인증</h1>
            <p className="text-[13px] text-muted mt-1">인증 앱의 6자리 코드를 입력하세요.<span className="block text-faint">휴대폰이 없으면 복구 코드</span></p>
          </div>
          <label className="flex flex-col gap-1.5 text-[12px] text-muted">인증 코드
            <input id="otp" autoFocus value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="text"
              spellCheck={false} autoCapitalize="off" placeholder="123456" className={`${field} tracking-widest`} />
          </label>
        </> : <>
          <div>
            <h1 className="text-[18px] font-semibold">로그인</h1>
            <p className="text-[13px] text-muted mt-1">계정이 없으면 관리자에게 요청하세요.</p>
          </div>
          <label className="flex flex-col gap-1.5 text-[12px] text-muted">아이디
            <input id="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} autoCapitalize="off" className={field} />
          </label>
          <label className="flex flex-col gap-1.5 text-[12px] text-muted">비밀번호
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" className={field} />
          </label>
        </>}
        {error && <p role="alert" className="text-[13px] text-fail -mt-2">{error}</p>}
        <button type="submit" disabled={busy || (ticket ? !code.trim() : !username.trim() || !password)}
          className="h-10 rounded-full bg-accent text-onaccent text-[14px] font-medium hover:brightness-110 disabled:opacity-50">
          {busy ? '확인 중…' : ticket ? '확인' : '로그인'}
        </button>
        {ticket && <button type="button" onClick={() => { setTicket(null); setError('') }} className="-mt-2 text-[12px] text-muted hover:text-fg">처음으로</button>}
      </form>
    </div>
  )
}
