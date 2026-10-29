import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type AuditRow, type Me, type Role, type SettingInfo, type UserInfo } from '../api'
import { OtpSetup, RecoveryCodes } from './OtpSetup'

const inp = 'w-full h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none text-[14px] text-fg font-mono'
const btn = 'h-9 px-4 rounded-full text-[13px]'

type Tab = 'general' | 'users' | 'audit' | 'account'
const TAB_LABEL: Record<Tab, string> = { general: '일반', users: '사용자', audit: '기록', account: '내 계정' }

/** 설정 창. 관리자: 일반·사용자·내 계정, 일반 사용자: 내 계정 */
export function Settings({ me, onClose, onSaved, onError }: { me: Me; onClose: () => void; onSaved: (msg: string) => void; onError: (e: unknown) => void }) {
  const tabs: Tab[] = [...(me.admin ? (['general', 'users', 'audit'] as Tab[]) : []), ...(me.account ? (['account'] as Tab[]) : [])]
  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'account')
  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h3 id="mTitle" className="text-[17px] font-semibold mr-auto">설정</h3>
        {tabs.length > 1 && (
          <div role="tablist" aria-label="설정 종류" className="flex gap-0.5 p-0.5 rounded-full bg-hover text-[12px]">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}
                className={`h-7 px-3 rounded-full ${tab === t ? 'bg-accent text-onaccent font-semibold' : 'text-muted hover:text-fg'}`}>{TAB_LABEL[t]}</button>
            ))}
          </div>
        )}
      </div>
      {tab === 'general' && <General onClose={onClose} onSaved={() => onSaved('설정을 저장했습니다')} onError={onError} />}
      {tab === 'users' && <Users me={me} onError={onError} onSaved={onSaved} />}
      {tab === 'audit' && <Audit onError={onError} />}
      {tab === 'account' && <Account me={me} onClose={onClose} onSaved={onSaved} />}
      {tabs.length === 0 && <p className="text-[13px] text-muted">관리자 토큰으로 접속 중이라 바꿀 수 있는 설정이 없습니다.</p>}
    </div>
  )
}

// ------------------------------------------------------------------ 일반 (관리자)
const LABELS: Record<string, { label: string; placeholder: string }> = {
  beszel_url: { label: 'Beszel 주소', placeholder: 'https://beszel.example.com/system/{name}' },
  public_url: { label: '이 Makeboard 서버 주소', placeholder: 'http://192.168.0.4:8000' },
}

/** 저장한 값이 .env 값보다 우선하고, 되돌리면 .env 값을 쓴다. */
function General({ onClose, onSaved, onError }: { onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
  const [info, setInfo] = useState<Record<string, SettingInfo> | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const apply = (d: Record<string, SettingInfo>) => {
    setInfo(d)
    setDraft(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.value])))
  }
  useEffect(() => { api.settings().then(apply).catch(onError) }, [onError])

  const save = async (changes: Record<string, string | null>): Promise<boolean> => {
    setBusy(true); setError('')
    try { apply(await api.saveSettings(changes)); onSaved(); return true } catch (e) { setError((e as Error).message); return false } finally { setBusy(false) }
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!info) return
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v.trim() !== info[k].value))
    if (Object.keys(changed).length) void save(changed).then((ok) => { if (ok) onClose() })
    else onClose()
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <p className="text-[13px] text-muted -mt-1">저장한 값이 .env 보다 우선합니다. 비우면 꺼집니다.</p>
      {!info ? <p className="text-[13px] text-muted">불러오는 중…</p> : Object.entries(info).map(([k, v]) => (
        <div key={k} className="flex flex-col gap-1.5">
          <label htmlFor={`set-${k}`} className="text-[12px] text-muted">{LABELS[k]?.label ?? k} <span className="text-faint">{v.help}</span></label>
          <input id={`set-${k}`} className={inp} value={draft[k] ?? ''} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}
            autoComplete="off" spellCheck={false} placeholder={LABELS[k]?.placeholder} />
          <p className="text-[11.5px] text-faint flex items-center gap-2 min-w-0">
            {v.saved ? <>
              <span className="truncate">웹에서 저장한 값 · .env 값: <span className="font-mono">{v.env || '(비어 있음)'}</span></span>
              <button type="button" disabled={busy} onClick={() => void save({ [k]: null })}
                className="flex-none text-accent hover:underline underline-offset-2 disabled:opacity-50">.env 값으로 되돌리기</button>
            </> : <span>.env 값을 쓰는 중</span>}
          </p>
        </div>
      ))}
      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} text-muted hover:bg-hover`}>취소</button>
        <button type="submit" disabled={busy || !info} className={`${btn} bg-accent text-onaccent disabled:opacity-50`}>{busy ? '저장하는 중…' : '저장'}</button>
      </div>
    </form>
  )
}

// ------------------------------------------------------------------ 사용자 (관리자)
const ROLE_LABEL: Record<Role, string> = { run: '실행', edit: '편집', admin: '관리자' }
const ROLE_TITLE: Record<Role, string> = { run: '보기와 명령 실행', edit: '+ Makefile·yaml 수정 · 2단계 인증 필수', admin: '+ 서버·사용자·설정 · 2단계 인증 필수' }

function RolePicker({ value, onChange, disabled, label }: { value: Role; onChange: (r: Role) => void; disabled?: boolean; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex gap-0.5 p-0.5 rounded-full bg-hover text-[12px] flex-none">
      {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
        <button key={r} type="button" role="radio" aria-checked={value === r} disabled={disabled} title={ROLE_TITLE[r]} onClick={() => value !== r && onChange(r)}
          className={`h-6 px-2.5 rounded-full disabled:opacity-60 ${value === r ? 'bg-accent text-onaccent font-semibold' : 'text-muted hover:text-fg'}`}>{ROLE_LABEL[r]}</button>
      ))}
    </div>
  )
}

function Users({ me, onError, onSaved }: { me: Me; onError: (e: unknown) => void; onSaved: (msg: string) => void }) {
  const [users, setUsers] = useState<UserInfo[] | null>(null)
  const [name, setName] = useState('')
  const [display, setDisplay] = useState('')
  const [pw, setPw] = useState('')
  const [role, setRole] = useState<Role>('run')
  // 비밀번호를 재설정하는 중인 사용자와 새 비밀번호
  const [resetFor, setResetFor] = useState<number | null>(null)
  const [resetPw, setResetPw] = useState('')
  const [confirmDel, setConfirmDel] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => api.users().then(setUsers).catch(onError), [onError])
  useEffect(() => { void load() }, [load])

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true); setError('')
    try { await fn(); await load(); onSaved(msg); return true } catch (e) { setError((e as Error).message); return false } finally { setBusy(false) }
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (await act(() => api.addUser(name.trim(), pw, display.trim(), role), `${name.trim()} 계정을 만들었습니다`)) { setName(''); setDisplay(''); setPw(''); setRole('run') }
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col rounded-xl border border-line divide-y divide-line">
        {!users && <li className="px-4 py-3 text-[13px] text-muted">불러오는 중…</li>}
        {users?.map((u) => (
          <li key={u.id} className="px-4 py-2.5 flex flex-col gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-wrap">
              <span className="font-mono text-[13.5px] font-medium truncate">{u.username}</span>
              {u.name && <span className="text-[13px] text-muted truncate">{u.name}</span>}
              {u.username === me.user && <span className="text-[11px] text-faint">나</span>}
              <span title={u.otp ? '2단계 인증 사용 중' : '2단계 인증 없음'}
                className={`text-[10.5px] font-semibold px-1.5 py-px rounded ${u.otp ? 'bg-ok/10 text-ok' : u.role === 'run' ? 'bg-hover text-faint' : 'bg-warn/10 text-warn'}`}>
                {u.otp ? '2단계 ✓' : u.role === 'run' ? '2단계 없음' : '2단계 등록 전'}</span>
              <span className="ml-auto">
                <RolePicker label={`${u.username} 권한`} value={u.role} disabled={busy || u.username === me.user}
                  onChange={(r) => void act(() => api.updateUser(u.id, { role: r }), `${u.username}의 권한을 ${ROLE_LABEL[r]}(으)로 바꿨습니다`)} />
              </span>
            </div>
            <div className="flex items-center gap-1 text-[12px] -ml-2.5">
                <button type="button" disabled={busy} onClick={() => { setResetFor(resetFor === u.id ? null : u.id); setResetPw(''); setConfirmDel(null) }}
                  className="h-7 px-2.5 rounded-full text-muted hover:text-fg hover:bg-hover disabled:opacity-50">비밀번호 재설정</button>
                {u.otp && u.username !== me.user && (
                  <button type="button" disabled={busy} title="휴대폰을 잃어버린 사용자. 다음 로그인 때 다시 등록합니다"
                    onClick={() => void act(() => api.updateUser(u.id, { reset_otp: true }), `${u.username}의 2단계 인증을 초기화했습니다`)}
                    className="h-7 px-2.5 rounded-full text-muted hover:text-fg hover:bg-hover disabled:opacity-50">2단계 인증 초기화</button>
                )}
                {u.username !== me.user && <>
                  {confirmDel === u.id
                    ? <button type="button" disabled={busy} onClick={() => void act(() => api.deleteUser(u.id), `${u.username} 계정을 지웠습니다`)}
                        className="h-7 px-2.5 rounded-full bg-fail text-white disabled:opacity-50">삭제 확인</button>
                    : <button type="button" disabled={busy} onClick={() => { setConfirmDel(u.id); setResetFor(null) }}
                        className="h-7 px-2.5 rounded-full text-muted hover:text-fail hover:bg-hover disabled:opacity-50">삭제</button>}
                </>}
            </div>
            {resetFor === u.id && (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void act(() => api.updateUser(u.id, { password: resetPw }), `${u.username}의 비밀번호를 바꿨습니다`).then((ok) => { if (ok) setResetFor(null) }) }}>
                <input type="password" className={`${inp} h-9`} value={resetPw} onChange={(e) => setResetPw(e.target.value)} autoFocus autoComplete="new-password" placeholder="새 비밀번호 (8자 이상)" aria-label={`${u.username} 새 비밀번호`} />
                <button type="submit" disabled={busy || resetPw.length < 8} className={`${btn} flex-none bg-accent text-onaccent disabled:opacity-50`}>바꾸기</button>
              </form>
            )}
          </li>
        ))}
      </ul>
      <details className="-mt-2 text-[12px] text-faint">
        <summary className="cursor-pointer select-none w-fit hover:text-muted">권한 안내</summary>
        <ul className="mt-1.5 flex flex-col gap-0.5 pl-1">
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <li key={r}><b className="font-semibold text-muted">{ROLE_LABEL[r]}</b> {ROLE_TITLE[r]}</li>)}
          <li>비밀번호를 재설정하면 그 사용자는 로그아웃됩니다.</li>
        </ul>
      </details>

      <form onSubmit={add} className="flex flex-col gap-2.5 rounded-xl bg-hover p-3.5">
        <span className="text-[12px] font-medium text-muted">사용자 추가</span>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder="아이디" aria-label="새 사용자 아이디" />
          <input className={`${inp} font-sans`} value={display} onChange={(e) => setDisplay(e.target.value)} autoComplete="off" placeholder="이름 (선택)" aria-label="새 사용자 이름" />
          <input type="password" className={inp} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" placeholder="비밀번호 (8자 이상)" aria-label="새 사용자 비밀번호" />
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-muted">권한</span>
          <RolePicker label="새 사용자 권한" value={role} onChange={setRole} />
          <button type="submit" disabled={busy || !name.trim() || pw.length < 8} className={`${btn} ml-auto bg-accent text-onaccent disabled:opacity-50`}>추가</button>
        </div>
      </form>
      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
    </div>
  )
}

// ------------------------------------------------------------------ 기록 (관리자)
const ACTION_LABEL: Record<string, string> = { 'env.reveal': '환경변수 보기', 'env.set': '환경변수 저장', 'env.delete': '환경변수 삭제', reauth: '다시 인증' }

function Audit({ onError }: { onError: (e: unknown) => void }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  useEffect(() => { api.audit().then(setRows).catch(onError) }, [onError])
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-faint">환경변수를 보거나 바꾼 기록입니다. 값은 남기지 않습니다.</p>
      <ul className="rounded-xl border border-line divide-y divide-line max-h-[420px] overflow-auto scroll-thin text-[12px]">
        {!rows && <li className="px-3.5 py-2.5 text-muted">불러오는 중…</li>}
        {rows?.length === 0 && <li className="px-3.5 py-2.5 text-muted">기록이 없습니다</li>}
        {rows?.map((r) => (
          <li key={r.id} className="px-3.5 py-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            <span className="text-faint tabular-nums">{r.at ? new Date(r.at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : ''}</span>
            <span><b className="font-semibold">{r.user}</b> · {ACTION_LABEL[r.action] ?? r.action}</span>
            <span className="text-faint font-mono">{r.ip}</span>
            <span className="font-mono text-muted break-all">{r.target}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ------------------------------------------------------------------ 내 계정
function Account({ me, onClose, onSaved }: { me: Me; onClose: () => void; onSaved: (msg: string) => void }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mismatch = again.length > 0 && next !== again

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api.changePassword(cur, next); onSaved('비밀번호를 바꿨습니다'); onClose() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="flex flex-col gap-5">
    <TwoFactor me={me} onSaved={onSaved} />
    <form onSubmit={submit} className="flex flex-col gap-3">
      <span className="text-[13px] font-semibold">비밀번호</span>
      <label className="flex flex-col gap-1.5 text-[12px] text-muted">현재 비밀번호
        <input type="password" className={inp} value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-muted">새 비밀번호 <span className="text-faint">8자 이상</span>
        <input type="password" className={inp} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </label>
      <label className="flex flex-col gap-1.5 text-[12px] text-muted">새 비밀번호 확인
        <input type="password" className={inp} value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" aria-invalid={mismatch} />
      </label>
      {mismatch && <p className="text-[12px] text-fail -mt-1">새 비밀번호가 서로 다릅니다</p>}
      <p className="text-[12px] text-faint">다른 기기는 로그아웃됩니다.</p>
      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} text-muted hover:bg-hover`}>취소</button>
        <button type="submit" disabled={busy || !cur || next.length < 8 || next !== again} className={`${btn} bg-accent text-onaccent disabled:opacity-50`}>
          {busy ? '바꾸는 중…' : '비밀번호 바꾸기'}</button>
      </div>
    </form>
    </div>
  )
}

/** 내 2단계 인증: 켜기(선택인 사용자), 복구 코드 새로 만들기, 끄기(필수가 아닌 사용자) */
function TwoFactor({ me, onSaved }: { me: Me; onSaved: (msg: string) => void }) {
  const [enabled, setEnabled] = useState(me.otp.enabled)
  const [mode, setMode] = useState<'idle' | 'setup' | 'recovery' | 'disable'>('idle')
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reset = () => { setMode('idle'); setCode(''); setError('') }

  const confirm = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      if (mode === 'recovery') { setCodes((await api.otpRecovery(code.trim())).recovery_codes); reset() }
      else { await api.otpDisable(code.trim()); setEnabled(false); onSaved('2단계 인증을 껐습니다'); reset() }
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line p-4">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold mr-auto">2단계 인증</span>
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${enabled ? 'bg-ok/10 text-ok' : 'bg-hover text-muted'}`}>{enabled ? '사용 중' : '꺼짐'}</span>
      </div>
      {codes ? <RecoveryCodes codes={codes} onDone={() => { setCodes(null); onSaved('복구 코드를 새로 만들었습니다') }} />
        : mode === 'setup' ? <OtpSetup onCancel={reset} onDone={() => { setEnabled(true); reset(); onSaved('2단계 인증을 켰습니다') }} />
        : mode !== 'idle' ? (
          <form onSubmit={confirm} className="flex flex-col gap-2">
            <span className="text-[12px] text-muted">{mode === 'recovery' ? '이전 복구 코드는 모두 무효가 됩니다.' : '끄면 비밀번호만으로 로그인합니다.'}<br />인증 앱의 코드를 입력하세요.</span>
            <div className="flex gap-2">
              <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" placeholder="123456" aria-label="인증 코드"
                className="flex-1 h-9 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none font-mono text-[14px] tracking-widest" />
              <button type="button" onClick={reset} className={`${btn} text-muted hover:bg-hover`}>취소</button>
              <button type="submit" disabled={busy || code.trim().length < 6} className={`${btn} bg-accent text-onaccent disabled:opacity-50`}>확인</button>
            </div>
            {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
          </form>
        ) : (
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[12px] text-muted mr-auto">{me.otp.required ? '관리자·편집자는 필수입니다.' : enabled ? '로그인할 때 코드를 함께 입력합니다.' : '비밀번호가 새어도 계정을 지킵니다.'}</p>
            {enabled ? <>
              <button type="button" onClick={() => setMode('recovery')} className={`${btn} border border-line hover:bg-hover`}>복구 코드 새로 만들기</button>
              {!me.otp.required && <button type="button" onClick={() => setMode('disable')} className={`${btn} text-muted hover:text-fail hover:bg-hover`}>끄기</button>}
            </> : <button type="button" onClick={() => setMode('setup')} className={`${btn} bg-accent text-onaccent`}>켜기</button>}
          </div>
        )}
    </section>
  )
}
