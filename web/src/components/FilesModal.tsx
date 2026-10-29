import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { api, type FileRev } from '../api'
import { editorKeyDown } from '../editorKeys'
import { Icon } from '../icons'
import type { ServiceDetail } from '../types'
import { CopyBox } from './CopyBox'
import { Select } from './Select'

const MAKEFILE = '__makefile__'
const btn = 'h-9 px-4 rounded-full text-[13px] inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50'
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '')

/** 서비스 폴더의 Makefile 과 yaml 파일. yaml 은 편집 권한이 있으면 고치고, 버전 기록에서 되돌릴 수 있다 */
export function FilesModal({ service, canEdit, onSync, onClose, initialPath = '' }: {
  service: ServiceDetail; canEdit: boolean; onSync: () => Promise<void>; onClose: () => void
  // 구성 화면에서 보던 파일(선택한 노드의 파일 또는 '볼 파일'). 목록에 있으면 그 파일로 연다
  initialPath?: string
}) {
  const [files, setFiles] = useState<{ path: string; size: number }[]>([])
  const [listError, setListError] = useState('')
  const [pick, setPick] = useState(MAKEFILE)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    api.files(service.id).then((f) => {
      setFiles(f)
      if (initialPath && f.some((x) => x.path === initialPath)) setPick(initialPath)
    }).catch((e) => setListError((e as Error).message))
  }, [service.id, initialPath])

  const options = [
    { value: MAKEFILE, label: 'Makefile', description: '노드 편집으로 고칩니다' },
    ...files.map((f) => ({ value: f.path, label: f.path, description: `${(f.size / 1024).toFixed(1)} KB` })),
  ]
  return (
    <div className="p-6 flex flex-col gap-4">
      <div className="min-w-0">
        <h3 id="mTitle" className="text-[17px] font-semibold">파일</h3>
        <p className="text-[13px] text-muted mt-1 font-mono truncate">{service.server?.id}:{service.path}</p>
      </div>
      <div className="flex flex-col gap-1">
        <div className={dirty ? 'pointer-events-none opacity-60' : ''}>
          <Select label="파일" value={pick} onChange={setPick} options={options} />
        </div>
        {dirty && <span className="text-[12px] text-warn">저장하지 않은 변경이 있습니다</span>}
        {listError && <span className="text-[12px] text-muted">yaml 파일 목록을 불러오지 못했습니다: {listError}</span>}
        {!listError && files.length === 0 && <span className="text-[12px] text-faint">yaml 파일 없음</span>}
      </div>
      {pick === MAKEFILE
        ? <MakefileView service={service} onSync={onSync} onClose={onClose} />
        : <YamlView key={pick} serviceId={service.id} path={pick} canEdit={canEdit} onDirty={setDirty} onClose={onClose} />}
    </div>
  )
}

function MakefileView({ service, onSync, onClose }: { service: ServiceDetail; onSync: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const sync = async () => {
    setBusy(true); setNote('')
    try { await onSync(); setNote('서버에서 다시 불러왔습니다') } catch (e) { setNote((e as Error).message) } finally { setBusy(false) }
  }
  return <>
    {service.sync_error && <p className="text-[13px] text-fail">{service.sync_error}</p>}
    <CopyBox text={service.makefile}>
      <pre className="rounded-xl bg-hover p-4 pr-14 text-[12px] leading-relaxed font-mono whitespace-pre overflow-auto scroll-thin max-h-[50vh]">{service.makefile || '(비어 있음)'}</pre>
    </CopyBox>
    <div className="flex items-center gap-2">
      <span className="text-[12px] text-faint mr-auto" title="웹에서 저장하면 이전 내용은 서버의 Makefile.makeboard.bak 에 남습니다">{note || (service.synced_at ? `${when(service.synced_at)} 동기화` : '')}</span>
      <button type="button" onClick={sync} disabled={busy} className={`${btn} border border-line hover:bg-hover`}><Icon name="refresh" size={14} />다시 불러오기</button>
      <button type="button" onClick={onClose} className={`${btn} text-muted hover:bg-hover`}>닫기</button>
    </div>
  </>
}

function YamlView({ serviceId, path, canEdit, onDirty, onClose }: {
  serviceId: number; path: string; canEdit: boolean; onDirty: (d: boolean) => void; onClose: () => void
}) {
  const [file, setFile] = useState<{ content: string; sha: string; readonly: string | null } | null>(null)
  const [text, setText] = useState('')
  const [history, setHistory] = useState<FileRev[] | null>(null)
  const [viewRev, setViewRev] = useState<(FileRev & { content: string }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const area = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    setError('')
    try { const f = await api.file(serviceId, path); setFile(f); setText(f.content) } catch (e) { setError((e as Error).message) }
  }, [serviceId, path])
  const loadHistory = useCallback(() => api.fileHistory(serviceId, path).then(setHistory).catch(() => setHistory([])), [serviceId, path])
  useEffect(() => { void load(); void loadHistory() }, [load, loadHistory])

  const editable = canEdit && !!file && !file.readonly
  const dirty = !!file && text !== file.content
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])

  const run = async (fn: () => Promise<{ changed: boolean }>, msg: string) => {
    if (!file) return
    setBusy(true); setError(''); setNote('')
    try {
      const r = await fn()
      await load(); await loadHistory(); setViewRev(null)
      setNote(r.changed ? msg : '바뀐 내용이 없습니다')
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const save = () => run(() => api.saveFile(serviceId, path, text, file!.sha), '저장했습니다')
  const revert = (rev: number) => run(() => api.revertFile(serviceId, rev, file!.sha), `${rev}번 버전으로 되돌렸습니다`)

  // 탭 키는 들여쓰기(공백 2칸), Ctrl/Cmd+S 는 저장
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => editorKeyDown(e, setText, () => { if (dirty && !busy) void save() })

  if (error && !file) return <p className="text-[13px] text-fail">{error}</p>
  if (!file) return <p className="text-[13px] text-muted">불러오는 중…</p>
  return <>
    {file.readonly && <p className="text-[12px] text-warn bg-warn/10 rounded-lg px-3 py-2">{file.readonly}</p>}
    {viewRev ? (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="font-medium">{viewRev.id}번 · {viewRev.note}</span>
          <span className="text-muted">{viewRev.author && `${viewRev.author} · `}{when(viewRev.created_at)}</span>
          <button type="button" onClick={() => setViewRev(null)} className="ml-auto text-muted hover:text-fg">현재 파일로</button>
        </div>
        <CopyBox text={viewRev.content}>
          <pre className="rounded-xl bg-hover p-4 pr-14 text-[12px] leading-relaxed font-mono whitespace-pre overflow-auto scroll-thin max-h-[400px]">{viewRev.content || '(비어 있음)'}</pre>
        </CopyBox>
      </div>
    ) : editable ? (
      <CopyBox text={text}>
        <textarea ref={area} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} spellCheck={false} aria-label={`${path} 내용`}
          className="block w-full h-[50vh] rounded-xl bg-hover p-4 pr-14 text-[12px] leading-relaxed font-mono whitespace-pre overflow-auto scroll-thin outline-none border border-transparent focus:border-accent resize-y" />
      </CopyBox>
    ) : (
      <CopyBox text={file.content}>
        <pre className="rounded-xl bg-hover p-4 pr-14 text-[12px] leading-relaxed font-mono whitespace-pre overflow-auto scroll-thin max-h-[50vh]">{file.content || '(비어 있음)'}</pre>
      </CopyBox>
    )}
    {error && <p role="alert" className="text-[13px] text-fail whitespace-pre-wrap">{error}</p>}

    {history && history.length > 0 && (
      <details className="rounded-xl border border-line">
        <summary className="px-3.5 py-2 text-[12px] text-muted cursor-pointer select-none">변경 기록 {history.length}개</summary>
        <ul className="max-h-[180px] overflow-auto scroll-thin divide-y divide-line border-t border-line">
          {history.map((h) => (
            <li key={h.id} className="px-3.5 py-1.5 flex items-center gap-2 text-[12px]">
              <span className="tabular-nums text-faint w-8">{h.id}</span>
              <span className="font-medium">{h.note}</span>
              <span className="text-muted truncate">{h.author && `${h.author} · `}{when(h.created_at)}</span>
              <span className="ml-auto flex gap-1 flex-none">
                <button type="button" onClick={() => api.fileRevision(serviceId, h.id).then(setViewRev).catch((e) => setError((e as Error).message))}
                  className="h-6 px-2 rounded-full text-muted hover:text-fg hover:bg-hover">보기</button>
                {canEdit && !file.readonly && h.sha !== file.sha && (
                  <button type="button" disabled={busy || dirty} onClick={() => void revert(h.id)} title={dirty ? '저장하지 않은 변경을 먼저 정리하세요' : undefined}
                    className="h-6 px-2 rounded-full text-accent hover:bg-accentsoft disabled:opacity-50">되돌리기</button>
                )}
                {h.sha === file.sha && <span className="h-6 px-2 text-faint">현재</span>}
              </span>
            </li>
          ))}
        </ul>
      </details>
    )}

    <div className="flex items-center gap-2">
      <span className="text-[12px] text-faint mr-auto">{note || (editable ? '저장 후 배포해야 반영됩니다' : canEdit ? '' : '보기 전용')}</span>
      <button type="button" onClick={() => void load()} disabled={busy || dirty} className={`${btn} border border-line hover:bg-hover`}><Icon name="refresh" size={14} />다시 불러오기</button>
      {editable && dirty && <button type="button" onClick={() => { setText(file.content); setError('') }} disabled={busy} className={`${btn} text-muted hover:bg-hover`}>변경 취소</button>}
      {editable
        ? <button type="button" onClick={() => void save()} disabled={busy || !dirty} className={`${btn} bg-accent text-onaccent px-4`}>{busy ? '저장하는 중…' : '저장'}</button>
        : <button type="button" onClick={onClose} className={`${btn} text-muted hover:bg-hover`}>닫기</button>}
    </div>
  </>
}
