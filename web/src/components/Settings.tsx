import { useEffect, useState, type FormEvent } from 'react'
import { api, type SettingInfo } from '../api'

const inp = 'w-full h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none text-[14px] text-fg font-mono'

const LABELS: Record<string, { label: string; placeholder: string }> = {
  beszel_url: { label: 'Beszel 주소', placeholder: 'https://beszel.example.com/system/{name}' },
  public_url: { label: '이 Makeboard 서버 주소', placeholder: 'http://192.168.0.4:8000' },
}

/** Makeboard 전체 설정. 저장한 값이 .env 값보다 우선하고, 되돌리면 .env 값을 쓴다. */
export function Settings({ onClose, onSaved, onError }: { onClose: () => void; onSaved: () => void; onError: (e: unknown) => void }) {
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
    <form onSubmit={submit} className="p-6 flex flex-col gap-4">
      <div>
        <h3 id="mTitle" className="text-[17px] font-semibold">설정</h3>
        <p className="text-[13px] text-muted mt-1">여기서 저장한 값이 .env 값보다 우선합니다. 비워 두고 저장하면 그 기능을 끕니다.</p>
      </div>
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
        <button type="button" onClick={onClose} className="h-9 px-4 rounded-full text-[13px] text-muted hover:bg-hover">취소</button>
        <button type="submit" disabled={busy || !info} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] disabled:opacity-50">
          {busy ? '저장하는 중…' : '저장'}</button>
      </div>
    </form>
  )
}
