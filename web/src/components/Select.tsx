import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '../icons'

export interface SelectOption { value: string; label: string; description?: string }

/** 기본 select 대신 쓰는 드롭다운. 항목마다 설명을 한 줄 더 보여줄 수 있다.
 *  variant: field(입력칸 모양) · pill(도구 막대용 작은 둥근 버튼). mono 는 고정폭 글꼴.
 *  키보드: Enter·Space·↓ 로 열기, ↑↓ 로 이동, Enter 로 고르기, Esc 로 닫기 */
export function Select({ value, options, onChange, label, className = '', placeholder = '선택', variant = 'field', mono = false }: {
  value: string; options: SelectOption[]; onChange: (v: string) => void; label: string; className?: string
  placeholder?: string; variant?: 'field' | 'pill'; mono?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const current = options.find((o) => o.value === value)
  const pill = variant === 'pill'
  const font = mono ? 'font-mono' : ''

  // 바깥을 누르면 닫는다
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  // 키보드로 움직인 항목이 보이게 스크롤
  useEffect(() => { if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' }) }, [open, active])

  const openList = () => {
    if (!options.length) return
    setActive(Math.max(0, options.findIndex((o) => o.value === value))); setOpen(true)
  }
  const pick = (i: number) => { const o = options[i]; if (o) onChange(o.value); setOpen(false) }

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); openList() }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active) }
    // 화면의 다른 Esc 동작(패널 닫기 등)까지 가지 않게 막는다
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
    else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <div ref={root} className={`relative ${className}`}>
      <button type="button" role="combobox" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        onClick={() => (open ? setOpen(false) : openList())} onKeyDown={onKey}
        className={pill
          ? `w-full h-7 px-2.5 rounded-full bg-hover text-[12px] text-left flex items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${open ? 'text-fg' : 'text-muted hover:text-fg'}`
          : `w-full min-h-10 px-3.5 py-2 rounded-xl bg-bg border text-fg text-left flex items-center gap-3 outline-none ${open ? 'border-accent' : 'border-line hover:border-edge focus-visible:border-accent'}`}>
        <span className="flex-1 min-w-0">
          <span className={`block truncate ${font} ${pill ? '' : 'text-[14px] font-medium'} ${current ? '' : 'text-faint'}`}>{current?.label ?? placeholder}</span>
          {!pill && current?.description && <span className="block text-[12px] text-muted truncate">{current.description}</span>}
        </span>
        <Icon name="down" size={pill ? 13 : 16} sw={2} className={`flex-none text-faint transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ul ref={list} id={`${id}-list`} role="listbox" aria-label={label}
          className={`absolute z-30 mt-1.5 max-h-[320px] overflow-auto scroll-thin bg-panel border border-line rounded-xl shadow-xl p-1.5
            ${pill ? 'right-0 w-max min-w-full max-w-[min(340px,90vw)]' : 'left-0 right-0'}`}>
          {options.map((o, i) => (
            <li key={o.value} id={`${id}-${i}`} role="option" aria-selected={o.value === value}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}
              className={`${pill ? 'px-2.5 py-1.5' : 'px-3 py-2'} rounded-lg cursor-pointer flex items-start gap-2.5 ${i === active ? 'bg-hover' : ''}`}>
              <span className="flex-1 min-w-0">
                <span className={`block ${font} ${pill ? 'text-[12.5px] whitespace-nowrap' : 'text-[13.5px]'} ${o.value === value ? 'text-accent font-semibold' : 'font-medium'}`}>{o.label}</span>
                {o.description && <span className="block text-[12px] text-muted leading-snug mt-0.5">{o.description}</span>}
              </span>
              {o.value === value && <Icon name="check" size={15} sw={2.2} className="flex-none text-accent mt-0.5" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
