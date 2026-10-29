import type { KeyboardEvent } from 'react'

const INDENT = '  '

/** yaml 편집칸의 키: Tab 들여쓰기, Shift+Tab 내어쓰기(여러 줄 선택 가능), Ctrl/Cmd+S 저장 */
export function editorKeyDown(e: KeyboardEvent<HTMLTextAreaElement>, setText: (v: string) => void, onSave?: () => void) {
  if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    onSave?.()
    return
  }
  if (e.key !== 'Tab' || e.altKey || e.metaKey || e.ctrlKey) return
  e.preventDefault()
  const el = e.currentTarget
  const text = el.value
  const { selectionStart: a, selectionEnd: b } = el
  const lineStart = text.lastIndexOf('\n', a - 1) + 1
  const multi = text.slice(a, b).includes('\n')

  if (!e.shiftKey && !multi) {
    // 커서 위치에 공백 두 칸
    setText(text.slice(0, a) + INDENT + text.slice(b))
    requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + INDENT.length })
    return
  }
  // 선택한 줄들(또는 커서 줄)을 한꺼번에 들이거나 내기
  const end = b > a && text[b - 1] === '\n' ? b - 1 : b
  const blockEnd = text.indexOf('\n', end) === -1 ? text.length : text.indexOf('\n', end)
  const lines = text.slice(lineStart, blockEnd).split('\n')
  let firstShift = 0, total = 0
  const changed = lines.map((l, i) => {
    if (e.shiftKey) {
      const cut = l.startsWith(INDENT) ? INDENT.length : l.startsWith(' ') ? 1 : 0
      if (i === 0) firstShift = -cut
      total -= cut
      return l.slice(cut)
    }
    if (i === 0) firstShift = INDENT.length
    total += INDENT.length
    return INDENT + l
  })
  setText(text.slice(0, lineStart) + changed.join('\n') + text.slice(blockEnd))
  requestAnimationFrame(() => {
    el.selectionStart = Math.max(lineStart, a + firstShift)
    el.selectionEnd = b + total
  })
}
