import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'

const field = 'h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none font-mono text-[14px] text-fg tracking-widest'

/** 복구 코드 보여주기. 이 화면을 닫으면 다시 볼 수 없다 */
export function RecoveryCodes({ codes, onDone, doneLabel = '저장했습니다' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  const [note, setNote] = useState('')
  const copy = async () => {
    try { await navigator.clipboard.writeText(codes.join('\n')); setNote('복사했습니다') } catch { setNote('직접 선택해서 복사하세요') }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-muted">휴대폰을 잃어버렸을 때 쓰는 복구 코드입니다. 각각 한 번씩 쓸 수 있습니다.<br /><b className="text-fg">지금만 볼 수 있으니 안전한 곳에 저장하세요.</b></p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl bg-hover px-5 py-4 font-mono text-[14px] tabular-nums select-all">
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-faint mr-auto">{note}</span>
        <button type="button" onClick={copy} className="h-9 px-4 rounded-full border border-line text-[13px] hover:bg-hover">복사</button>
        <button type="button" onClick={onDone} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px]">{doneLabel}</button>
      </div>
    </div>
  )
}

/** 2단계 인증 등록: QR 을 인증 앱으로 찍고 코드를 한 번 맞히면 켜지고, 복구 코드를 보여준다 */
export function OtpSetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { api.otpSetup().then(setSetup).catch((e) => setError((e as Error).message)) }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { setCodes((await api.otpEnable(code.trim())).recovery_codes) } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} doneLabel="저장했습니다, 계속" />
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-[13px] text-muted" title="Google Authenticator, 1Password, Authy 등">인증 앱으로 QR을 찍고, 앱에 뜬 6자리 코드를 입력하세요.</p>
      <div className="flex flex-col sm:flex-row items-center gap-4">
        <div className="w-[180px] h-[180px] flex-none rounded-xl bg-white grid place-items-center border border-line">
          {setup ? <img src={setup.qr} alt="2단계 인증 등록용 QR 코드" className="w-[164px] h-[164px] [image-rendering:pixelated]" /> : <span className="text-[12px] text-muted">불러오는 중…</span>}
        </div>
        <div className="flex flex-col gap-1.5 min-w-0 text-[12px] text-muted">
          QR 대신 직접 입력할 키
          <code className="font-mono text-[13px] text-fg break-all rounded-lg bg-hover px-3 py-2 select-all">{setup?.secret.replace(/(.{4})/g, '$1 ').trim() ?? '…'}</code>
        </div>
      </div>
      <label className="flex flex-col gap-1.5 text-[12px] text-muted">인증 코드
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" maxLength={8} placeholder="123456" className={field} />
      </label>
      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <button type="button" onClick={onCancel} className="h-9 px-4 rounded-full text-[13px] text-muted hover:bg-hover">취소</button>}
        <button type="submit" disabled={busy || !setup || code.trim().length < 6} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] disabled:opacity-50">
          {busy ? '확인 중…' : '등록'}</button>
      </div>
    </form>
  )
}
