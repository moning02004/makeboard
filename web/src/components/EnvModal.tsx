import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, api, type EnvFile, type Me } from '../api'
import { Icon } from '../icons'
import { Select } from './Select'

const inp = 'h-8 px-2.5 rounded-lg bg-bg border border-line focus:border-accent outline-none text-[12.5px] font-mono'
const small = 'h-7 px-2.5 rounded-full text-[12px] disabled:opacity-50'
const MASK = '••••••'
const HIDE_AFTER = 60_000 // 드러낸 값은 1분 뒤 다시 가린다

/** 서비스 폴더의 .env 파일. 값은 가려 두고, 보기·수정·삭제는 편집 권한 + 다시 인증(10분) */
export function EnvModal({ serviceId, me, onClose }: { serviceId: number; me: Me; onClose: () => void }) {
  const [files, setFiles] = useState<EnvFile[] | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [path, setPath] = useState('')
  const [shown, setShown] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<{ key: string; value: string; isNew?: boolean } | null>(null)
  const [askDelete, setAskDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  // 다시 인증이 필요할 때 하려던 동작을 기억했다가 인증 뒤 이어서 한다
  const [pending, setPending] = useState<(() => Promise<void>) | null>(null)
  const [code, setCode] = useState('')
  const timers = useRef<number[]>([])

  const load = useCallback(async () => {
    setError('')
    try {
      const r = await api.envList(serviceId)
      setFiles(r.files); setCanEdit(r.can_edit)
      setPath((p) => (r.files.some((f) => f.path === p) ? p : r.files[0]?.path ?? ''))
    } catch (e) { setError((e as Error).message) }
  }, [serviceId])
  useEffect(() => { void load() }, [load])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const file = files?.find((f) => f.path === path)
  const id = (k: string) => `${path}\u0000${k}`

  // 다시 인증이 필요하면(428) 코드를 묻고, 맞히면 그 동작을 다시 한다
  const guarded = async (fn: () => Promise<void>) => {
    setBusy(true); setError(''); setNote('')
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

  const reveal = (k: string) => guarded(async () => {
    const { value } = await api.envReveal(serviceId, path, k)
    setShown((s) => ({ ...s, [id(k)]: value }))
    timers.current.push(window.setTimeout(() => setShown((s) => { const n = { ...s }; delete n[id(k)]; return n }), HIDE_AFTER))
  })
  const save = (k: string, value: string | null) => guarded(async () => {
    await api.envSet(serviceId, path, k, value, file?.sha ?? '')
    setShown((s) => { const n = { ...s }; delete n[id(k)]; return n })
    setEditing(null); setAskDelete(null)
    setNote(value === null ? `${k} 을(를) 지웠습니다` : `${k} 을(를) 저장했습니다`)
    await load()
  })
  const startEdit = (k: string) => guarded(async () => {
    // 지금 값을 채워서 고치게 한다 (값을 받으려면 다시 인증이 필요)
    const value = shown[id(k)] ?? (await api.envReveal(serviceId, path, k)).value
    setEditing({ key: k, value })
  })

  return (
    <div className="p-6 flex flex-col gap-4">
      <div>
        <h3 id="mTitle" className="text-[17px] font-semibold">환경변수</h3>
        <p className="text-[13px] text-muted mt-1">{canEdit ? '값은 가려져 있습니다. 보기·수정하려면 한 번 더 인증합니다.' : '값은 편집 권한이 있어야 볼 수 있습니다.'}</p>
      </div>

      {error && !files && <p className="text-[13px] text-muted">{error}</p>}
      {files && files.length === 0 && <p className="text-[13px] text-muted">서비스 폴더에 .env 파일이 없습니다.</p>}
      {files && files.length > 1 && (
        <Select label="환경변수 파일" value={path} onChange={(p) => { setPath(p); setEditing(null); setAskDelete(null) }}
          options={files.map((f) => ({ value: f.path, label: f.path, description: `키 ${f.keys.length}개` }))} />
      )}

      {pending && (
        <form onSubmit={submitReauth} className="flex flex-col gap-2 rounded-xl bg-accentsoft/60 border border-accent/30 p-3.5">
          <span className="text-[13px] font-medium">값을 다루려면 한 번 더 인증하세요 <span className="text-muted font-normal">· 10분 동안 유지</span></span>
          <div className="flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus aria-label={me.otp.enabled ? '인증 코드' : '비밀번호'}
              type={me.otp.enabled ? 'text' : 'password'} autoComplete={me.otp.enabled ? 'one-time-code' : 'current-password'}
              placeholder={me.otp.enabled ? '인증 앱의 6자리 코드' : '비밀번호'} className={`${inp} flex-1 h-9 text-[14px] ${me.otp.enabled ? 'tracking-widest' : ''}`} />
            <button type="button" onClick={() => setPending(null)} className={`${small} h-9 px-3 text-muted hover:bg-hover`}>취소</button>
            <button type="submit" disabled={busy || !code.trim()} className={`${small} h-9 px-4 bg-accent text-onaccent`}>확인</button>
          </div>
        </form>
      )}

      {file && (
        <ul className="flex flex-col rounded-xl border border-line divide-y divide-line max-h-[420px] overflow-auto scroll-thin">
          {file.keys.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">키가 없습니다</li>}
          {file.keys.map(({ key, empty }) => {
            const v = shown[id(key)]
            const isEditing = editing?.key === key && !editing.isNew
            return (
              <li key={key} className="px-3.5 py-2 flex flex-col gap-1.5">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-[12.5px] font-semibold truncate flex-none w-[38%]" title={key}>{key}</span>
                  {!isEditing && (
                    <span className={`font-mono text-[12.5px] truncate min-w-0 ${v === undefined ? 'text-faint tracking-wider' : ''}`} title={v}>
                      {v === undefined ? (empty ? '(비어 있음)' : MASK) : v || '(비어 있음)'}
                    </span>
                  )}
                  {canEdit && !isEditing && (
                    <span className="ml-auto flex items-center gap-0.5 flex-none">
                      {askDelete === key ? <>
                        <button type="button" onClick={() => setAskDelete(null)} className={`${small} text-muted hover:bg-hover`}>취소</button>
                        <button type="button" disabled={busy} onClick={() => void save(key, null)} className={`${small} bg-fail text-onaccent`}>삭제</button>
                      </> : <>
                        {!empty && (v === undefined
                          ? <button type="button" disabled={busy} onClick={() => void reveal(key)} className={`${small} text-muted hover:text-fg hover:bg-hover`}>보기</button>
                          : <button type="button" onClick={() => setShown((s) => { const n = { ...s }; delete n[id(key)]; return n })} className={`${small} text-muted hover:text-fg hover:bg-hover`}>가리기</button>)}
                        <button type="button" disabled={busy} onClick={() => void startEdit(key)} className={`${small} text-muted hover:text-fg hover:bg-hover`}>수정</button>
                        <button type="button" onClick={() => setAskDelete(key)} className={`${small} text-muted hover:text-fail hover:bg-hover`}>삭제</button>
                      </>}
                    </span>
                  )}
                </div>
                {isEditing && (
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void save(key, editing.value) }}>
                    <input value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} autoFocus spellCheck={false} autoComplete="off"
                      aria-label={`${key} 값`} className={`${inp} flex-1`} />
                    <button type="button" onClick={() => setEditing(null)} className={`${small} h-8 text-muted hover:bg-hover`}>취소</button>
                    <button type="submit" disabled={busy} className={`${small} h-8 px-3.5 bg-accent text-onaccent`}>저장</button>
                  </form>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {file && canEdit && (
        editing?.isNew ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void save(editing.key.trim(), editing.value) }}>
            <input value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} autoFocus placeholder="KEY" aria-label="새 키" spellCheck={false} autoComplete="off" className={`${inp} w-[38%]`} />
            <input value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} placeholder="값" aria-label="새 값" spellCheck={false} autoComplete="off" className={`${inp} flex-1`} />
            <button type="button" onClick={() => setEditing(null)} className={`${small} h-8 text-muted hover:bg-hover`}>취소</button>
            <button type="submit" disabled={busy || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(editing.key.trim()) || file.keys.some((k) => k.key === editing.key.trim())}
              className={`${small} h-8 px-3.5 bg-accent text-onaccent`}>추가</button>
          </form>
        ) : (
          <button type="button" onClick={() => setEditing({ key: '', value: '', isNew: true })} className={`${small} self-start inline-flex items-center gap-1 text-accent hover:bg-accentsoft`}>
            <Icon name="plus" size={13} sw={2.2} />키 추가</button>
        )
      )}

      {error && files && <p role="alert" className="text-[13px] text-fail">{error}</p>}
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-faint mr-auto min-w-0 truncate" title="값은 서버에 저장하지 않고, 누가 어떤 키를 보고 바꿨는지만 기록합니다">
          {note || (canEdit && file ? '기록에 남습니다 · 저장 후 다시 시작해야 반영' : '')}</span>
        <button type="button" onClick={() => void load()} className="h-9 px-4 rounded-full border border-line text-[13px] hover:bg-hover inline-flex items-center gap-1.5 whitespace-nowrap"><Icon name="refresh" size={14} />다시 불러오기</button>
        <button type="button" onClick={onClose} className="h-9 px-4 rounded-full text-[13px] text-muted hover:bg-hover">닫기</button>
      </div>
    </div>
  )
}
