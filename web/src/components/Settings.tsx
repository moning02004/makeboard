import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Me, type SettingInfo, type UserInfo } from '../api'

const inp = 'w-full h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none text-[14px] text-fg font-mono'
const btn = 'h-9 px-4 rounded-full text-[13px]'

type Tab = 'general' | 'users' | 'account'
const TAB_LABEL: Record<Tab, string> = { general: '일반', users: '사용자', account: '내 계정' }

/** 설정 창. 관리자: 일반·사용자·내 계정, 일반 사용자: 내 계정 */
export function Settings({ me, onClose, onSaved, onError }: { me: Me; onClose: () => void; onSaved: (msg: string) => void; onError: (e: unknown) => void }) {
  const tabs: Tab[] = [...(me.admin ? (['general', 'users'] as Tab[]) : []), ...(me.account ? (['account'] as Tab[]) : [])]
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
      {tab === 'account' && <Account onClose={onClose} onSaved={() => onSaved('비밀번호를 바꿨습니다')} />}
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
      <p className="text-[13px] text-muted -mt-1">여기서 저장한 값이 .env 값보다 우선합니다. 비워 두고 저장하면 그 기능을 끕니다.</p>
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
function Users({ me, onError, onSaved }: { me: Me; onError: (e: unknown) => void; onSaved: (msg: string) => void }) {
  const [users, setUsers] = useState<UserInfo[] | null>(null)
  const [name, setName] = useState('')
  const [display, setDisplay] = useState('')
  const [pw, setPw] = useState('')
  const [admin, setAdmin] = useState(false)
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
    if (await act(() => api.addUser(name.trim(), pw, display.trim(), admin), `${name.trim()} 계정을 만들었습니다`)) { setName(''); setDisplay(''); setPw(''); setAdmin(false) }
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col rounded-xl border border-line divide-y divide-line">
        {!users && <li className="px-4 py-3 text-[13px] text-muted">불러오는 중…</li>}
        {users?.map((u) => (
          <li key={u.id} className="px-4 py-2.5 flex flex-col gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[13.5px] font-medium truncate">{u.username}</span>
              {u.name && <span className="text-[13px] text-muted truncate">{u.name}</span>}
              {u.admin && <span className="text-[10.5px] font-semibold px-1.5 py-px rounded bg-accentsoft text-accent">관리자</span>}
              {u.username === me.user && <span className="text-[11px] text-faint">나</span>}
              <span className="ml-auto flex items-center gap-1 text-[12px]">
                <button type="button" disabled={busy} onClick={() => { setResetFor(resetFor === u.id ? null : u.id); setResetPw(''); setConfirmDel(null) }}
                  className="h-7 px-2.5 rounded-full text-muted hover:text-fg hover:bg-hover disabled:opacity-50">비밀번호</button>
                {u.username !== me.user && <>
                  <button type="button" disabled={busy} onClick={() => void act(() => api.updateUser(u.id, { admin: !u.admin }), u.admin ? `${u.username}의 관리자 권한을 뺐습니다` : `${u.username}을 관리자로 바꿨습니다`)}
                    className="h-7 px-2.5 rounded-full text-muted hover:text-fg hover:bg-hover disabled:opacity-50">{u.admin ? '관리자 해제' : '관리자로'}</button>
                  {confirmDel === u.id
                    ? <button type="button" disabled={busy} onClick={() => void act(() => api.deleteUser(u.id), `${u.username} 계정을 지웠습니다`)}
                        className="h-7 px-2.5 rounded-full bg-fail text-white disabled:opacity-50">삭제 확인</button>
                    : <button type="button" disabled={busy} onClick={() => { setConfirmDel(u.id); setResetFor(null) }}
                        className="h-7 px-2.5 rounded-full text-muted hover:text-fail hover:bg-hover disabled:opacity-50">삭제</button>}
                </>}
              </span>
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
      <p className="text-[12px] text-faint -mt-2">비밀번호를 바꾸면 그 사용자의 기존 로그인은 모두 끊깁니다. 서버 추가·삭제와 설정은 관리자만 할 수 있습니다.</p>

      <form onSubmit={add} className="flex flex-col gap-2.5 rounded-xl bg-hover p-3.5">
        <span className="text-[12px] font-medium text-muted">사용자 추가</span>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} autoCapitalize="off" placeholder="아이디" aria-label="새 사용자 아이디" />
          <input className={`${inp} font-sans`} value={display} onChange={(e) => setDisplay(e.target.value)} autoComplete="off" placeholder="이름 (선택)" aria-label="새 사용자 이름" />
          <input type="password" className={inp} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" placeholder="비밀번호 (8자 이상)" aria-label="새 사용자 비밀번호" />
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] text-muted cursor-pointer">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} className="accent-[rgb(var(--accent))]" />관리자
          </label>
          <button type="submit" disabled={busy || !name.trim() || pw.length < 8} className={`${btn} ml-auto bg-accent text-onaccent disabled:opacity-50`}>추가</button>
        </div>
      </form>
      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
    </div>
  )
}

// ------------------------------------------------------------------ 내 계정
function Account({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const mismatch = again.length > 0 && next !== again

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try { await api.changePassword(cur, next); onSaved(); onClose() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
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
      <p className="text-[12px] text-faint">바꾸면 다른 기기의 로그인은 끊기고, 이 기기는 그대로 유지됩니다.</p>
      {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={`${btn} text-muted hover:bg-hover`}>취소</button>
        <button type="submit" disabled={busy || !cur || next.length < 8 || next !== again} className={`${btn} bg-accent text-onaccent disabled:opacity-50`}>
          {busy ? '바꾸는 중…' : '비밀번호 바꾸기'}</button>
      </div>
    </form>
  )
}
