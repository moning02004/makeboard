import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, api, type Me } from '../api'
import { Icon } from '../icons'

const inp = 'h-8 px-2.5 rounded-lg bg-bg border border-line focus:border-accent outline-none text-[12.5px] font-mono min-w-0'
const small = 'h-7 px-2 rounded-full text-[12px] disabled:opacity-50 whitespace-nowrap'
const HIDE_AFTER = 60_000

/** 구성도 Secret 패널의 키 목록. 값 보기·수정·삭제는 편집 권한 + 다시 인증(10분), 기록에 남는다 */
export function SecretKeys({ serviceId, path, doc, me, onChanged }: {
  serviceId: number; path: string; doc: number; me: Me; onChanged: (msg: string) => void
}) {
  const [keys, setKeys] = useState<{ key: string; section: string; empty: boolean }[] | null>(null)
  const [sha, setSha] = useState('')
  const [shown, setShown] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<{ key: string; value: string; isNew?: boolean } | null>(null)
  const [askDelete, setAskDelete] = useState<string | null>(null)
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const timers = useRef<number[]>([])
  const canEdit = me.edit

  const load = useCallback(async () => {
    try { const r = await api.secretKeys(serviceId, path, doc); setKeys(r.keys); setSha(r.sha) } catch (e) { setError((e as Error).message) }
  }, [serviceId, path, doc])
  useEffect(() => { void load() }, [load])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const guarded = async (fn: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await fn() } catch (e) {
      if (e instanceof ApiError && e.status === 428) { setPending(() => fn); setCode('') } else setError((e as Error).message)
    } finally { setBusy(false) }
  }
  const submitReauth = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await api.reauth(me.otp.enabled ? { code: code.trim() } : { password: code })
      const fn = pending
      setPending(null)
      if (fn) await fn()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const hide = (k: string) => setShown((s) => { const n = { ...s }; delete n[k]; return n })
  const reveal = (k: string) => guarded(async () => {
    const r = await api.secretReveal(serviceId, path, doc, k)
    setShown((s) => ({ ...s, [k]: r.binary ? `(바이너리 · base64) ${r.value}` : r.value }))
    timers.current.push(window.setTimeout(() => hide(k), HIDE_AFTER))
  })
  const save = (k: string, value: string | null) => guarded(async () => {
    await api.secretSet(serviceId, path, doc, k, value, sha)
    hide(k); setEditing(null); setAskDelete(null)
    onChanged(value === null ? `${k} 키를 지웠습니다` : `${k} 키를 저장했습니다`)
  })
  const startEdit = (k: string) => guarded(async () => {
    const value = shown[k] ?? (await api.secretReveal(serviceId, path, doc, k)).value
    setEditing({ key: k, value })
  })

  if (!keys) return error ? <p className="text-[12px] text-fail">{error}</p> : null
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[12px] font-medium text-faint">키 <span className="font-normal">· 값은 가려져 있습니다{canEdit ? ', 보려면 한 번 더 인증' : ''}</span></h4>
      {pending && (
        <form onSubmit={submitReauth} className="flex flex-col gap-2 rounded-xl bg-accentsoft/60 border border-accent/30 p-3">
          <span className="text-[12.5px] font-medium">한 번 더 인증하세요 <span className="text-muted font-normal">· 10분 유지</span></span>
          <div className="flex gap-1.5">
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus type={me.otp.enabled ? 'text' : 'password'}
              aria-label={me.otp.enabled ? '인증 코드' : '비밀번호'} placeholder={me.otp.enabled ? '6자리 코드' : '비밀번호'}
              autoComplete={me.otp.enabled ? 'one-time-code' : 'current-password'} className={`${inp} flex-1`} />
            <button type="button" onClick={() => setPending(null)} className={`${small} px-2.5 text-muted hover:bg-hover`}>취소</button>
            <button type="submit" disabled={busy || !code.trim()} className={`${small} px-3 bg-accent text-onaccent`}>확인</button>
          </div>
        </form>
      )}
      <ul className="flex flex-col rounded-xl border border-line divide-y divide-line">
        {keys.length === 0 && <li className="px-3 py-2.5 text-[12px] text-muted">키가 없습니다</li>}
        {keys.map(({ key, empty }) => {
          const v = shown[key]
          const isEditing = editing?.key === key && !editing.isNew
          return (
            <li key={key} className="px-3 py-1.5 flex flex-col gap-1.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[12.5px] font-semibold truncate flex-none max-w-[40%]" title={key}>{key}</span>
                {!isEditing && (
                  <span className={`font-mono text-[12px] truncate min-w-0 flex-1 ${v === undefined ? 'text-faint tracking-wider' : ''}`} title={v}>
                    {v === undefined ? (empty ? '(비어 있음)' : '••••••') : v || '(비어 있음)'}
                  </span>
                )}
                {canEdit && !isEditing && (
                  <span className="ml-auto flex items-center flex-none">
                    {askDelete === key ? <>
                      <button type="button" onClick={() => setAskDelete(null)} className={`${small} text-muted hover:bg-hover`}>취소</button>
                      <button type="button" disabled={busy} onClick={() => void save(key, null)} className={`${small} px-2.5 bg-fail text-onaccent`}>삭제</button>
                    </> : <>
                      {!empty && (v === undefined
                        ? <button type="button" disabled={busy} onClick={() => void reveal(key)} className={`${small} text-muted hover:text-fg hover:bg-hover`}>보기</button>
                        : <button type="button" onClick={() => hide(key)} className={`${small} text-muted hover:text-fg hover:bg-hover`}>가리기</button>)}
                      <button type="button" disabled={busy} onClick={() => void startEdit(key)} className={`${small} text-muted hover:text-fg hover:bg-hover`}>수정</button>
                      <button type="button" onClick={() => setAskDelete(key)} aria-label={`${key} 삭제`} className={`${small} text-muted hover:text-fail hover:bg-hover`}><Icon name="trash" size={13} /></button>
                    </>}
                  </span>
                )}
              </div>
              {isEditing && (
                <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void save(key, editing.value) }}>
                  <input value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} autoFocus spellCheck={false} autoComplete="off"
                    aria-label={`${key} 값`} className={`${inp} flex-1`} />
                  <button type="button" onClick={() => setEditing(null)} className={`${small} h-8 px-2.5 text-muted hover:bg-hover`}>취소</button>
                  <button type="submit" disabled={busy} className={`${small} h-8 px-3 bg-accent text-onaccent`}>저장</button>
                </form>
              )}
            </li>
          )
        })}
      </ul>
      {canEdit && (editing?.isNew ? (
        <form className="flex gap-1.5" onSubmit={(e) => { e.preventDefault(); void save(editing.key.trim(), editing.value) }}>
          <input value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} autoFocus placeholder="key" aria-label="새 키" spellCheck={false} autoComplete="off" className={`${inp} w-[36%]`} />
          <input value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} placeholder="값" aria-label="새 값" spellCheck={false} autoComplete="off" className={`${inp} flex-1`} />
          <button type="button" onClick={() => setEditing(null)} className={`${small} h-8 px-2.5 text-muted hover:bg-hover`}>취소</button>
          <button type="submit" disabled={busy || !/^[-._a-zA-Z0-9]+$/.test(editing.key.trim()) || keys.some((k) => k.key === editing.key.trim())}
            className={`${small} h-8 px-3 bg-accent text-onaccent`}>추가</button>
        </form>
      ) : (
        <button type="button" onClick={() => setEditing({ key: '', value: '', isNew: true })} className={`${small} self-start inline-flex items-center gap-1 text-accent hover:bg-accentsoft`}>
          <Icon name="plus" size={13} sw={2.2} />키 추가</button>
      ))}
      {error && <p role="alert" className="text-[12px] text-fail">{error}</p>}
    </section>
  )
}
