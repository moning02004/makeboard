import { useState, type ReactNode } from 'react'
import { Icon } from '../icons'

/** 내용 상자의 오른쪽 위에 떠 있는 복사 버튼. 누르면 잠깐 ✓ 로 바뀐다 */
export function CopyBox({ text, children }: { text: string; children: ReactNode }) {
  const [done, setDone] = useState<'ok' | 'fail' | null>(null)
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone('ok') } catch { setDone('fail') }
    window.setTimeout(() => setDone(null), 1500)
  }
  return (
    <div className="relative group/copy">
      {children}
      <button type="button" onClick={copy} aria-label="복사" title={done === 'fail' ? '복사하지 못했습니다. 직접 선택하세요' : '복사'}
        className={`absolute top-2 right-3 w-8 h-8 grid place-items-center rounded-lg bg-panel/90 border border-line [box-shadow:var(--card-shadow)]
          ${done === 'ok' ? 'text-ok' : done === 'fail' ? 'text-fail' : 'text-muted hover:text-fg'}`}>
        <Icon name={done === 'ok' ? 'check' : 'copy'} size={15} sw={2} />
      </button>
    </div>
  )
}
