import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ServiceDetail } from '../types'

type Template = { id: string; name: string; description: string; content: string }

// Makefile 이 없는 서비스를 열었을 때: 템플릿을 골라 바로 만든다
export function InitMakefile({ service, onDone, onError }: { service: ServiceDetail; onDone: (d: ServiceDetail) => void; onError: (e: unknown) => void }) {
  const [templates, setTemplates] = useState<Template[]>([])
  const [pick, setPick] = useState('compose')
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.templates().then(setTemplates).catch(onError) }, [onError])
  const current = templates.find((t) => t.id === pick)

  const create = async () => {
    setBusy(true)
    try { onDone(await api.initMakefile(service.id, pick)) } catch (e) { onError(e) } finally { setBusy(false) }
  }

  return (
    <div className="w-full max-w-[640px] bg-panel border border-line rounded-2xl shadow-xl p-6 flex flex-col gap-4 text-left">
      <div>
        <h2 className="text-[17px] font-semibold">Makefile이 없습니다</h2>
        <p className="text-[13px] text-muted mt-1">
          <span className="font-mono">{service.server?.id}:{service.path}</span> 에 템플릿으로 새로 만듭니다. 만든 뒤 노드를 편집해 채워 나가면 됩니다.
        </p>
      </div>
      <div role="radiogroup" aria-label="템플릿" className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {templates.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={pick === t.id} onClick={() => setPick(t.id)}
            className={`text-left rounded-xl border px-3 py-2.5 ${pick === t.id ? 'border-accent bg-accentsoft' : 'border-line hover:bg-hover'}`}>
            <span className={`block text-[13px] font-medium ${pick === t.id ? 'text-accent' : ''}`}>{t.name}</span>
            <span className="block text-[12px] text-muted mt-0.5 leading-snug">{t.description}</span>
          </button>
        ))}
      </div>
      {current && (
        <pre className="rounded-xl bg-hover p-4 text-[12px] leading-relaxed font-mono whitespace-pre overflow-auto scroll-thin max-h-[260px]">{current.content}</pre>
      )}
      <div className="flex items-center justify-end gap-2">
        <span className="text-[12px] text-faint mr-auto">서버의 {service.path}/Makefile 로 저장됩니다</span>
        <button type="button" onClick={create} disabled={busy || !current} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] disabled:opacity-50">
          {busy ? '만드는 중…' : 'Makefile 만들기'}</button>
      </div>
    </div>
  )
}
