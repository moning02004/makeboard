// 노드 모델 다루기. Makefile 파싱과 최종 생성은 서버가 하고, 화면은 미리보기와 편집만 한다.
import type { MakeNode, Model, NodeType } from './types'


export const TYPE_LABEL: Record<NodeType, string> = {
  compose: 'Docker Compose', k8s: 'Kubernetes', python: 'Python', npm: 'npm', shell: 'Shell',
  comp: '복합 명령어', preset: '인자 프리셋', help: '기본 명령어',
}

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
export const VALUE_RE = /^[A-Za-z0-9_.,:/@+=%-]*$/
const BUILTIN = new Set(['MAKE', 'MAKEFILE_LIST', 'CURDIR', 'MAKEFLAGS'])

export function typeOf(nd: MakeNode): NodeType {
  if (nd.kind === 'help') return 'help'
  if (nd.kind === 'comp') return 'comp'
  if (nd.kind === 'preset') return 'preset'
  const r = (nd.cmds || []).join('\n')
  if (/kubectl|helm\b/.test(r)) return 'k8s'
  if (/docker[ -]compose|\$\(COMPOSE\)/.test(r)) return 'compose'
  if (/\bnpm\b|\bnpx\b|\bpnpm\b|\byarn\b/.test(r)) return 'npm'
  if (/\bpython3?\b|\bpip\b|\buv\b/.test(r)) return 'python'
  return 'shell'
}

export const refsOf = (nd: MakeNode): string[] =>
  nd.kind === 'comp' ? nd.steps || [] : nd.kind === 'preset' && nd.target ? [nd.target] : []

export const usedBy = (m: Model, n: string) => m.order.filter((k) => refsOf(m.nodes[k]).includes(n))

export function contains(m: Model, a: string, b: string, seen = new Set<string>()): boolean {
  if (a === b) return true
  const x = m.nodes[a]
  if (!x || seen.has(a)) return false
  seen.add(a)
  return refsOf(x).some((s) => contains(m, s, b, seen))
}

export function collect(m: Model, n: string, acc: string[] = []): string[] {
  if (acc.includes(n)) return acc
  acc.push(n)
  refsOf(m.nodes[n]).forEach((r) => collect(m, r, acc))
  return acc
}

export function groupsOf(m: Model): (string | null)[] {
  const g: (string | null)[] = []
  m.order.forEach((n) => {
    const x = m.nodes[n].group || null
    if (!g.includes(x)) g.push(x)
  })
  return [null, ...g.filter((x) => x !== null)]
}

export function varMap(m: Model): Record<string, { v: string; op: string }> {
  const out: Record<string, { v: string; op: string }> = {}
  for (const v of m.vars) {
    const cur = out[v.name]
    if (v.op === '+=' && cur) out[v.name] = { v: `${cur.v} ${v.v}`, op: cur.op }
    else if (v.op === '?=' && cur) continue
    else out[v.name] = { v: v.v, op: v.op }
  }
  return out
}

export function expand(cmd: string, m: Model, ov: Record<string, string> = {}): string {
  const all: Record<string, string> = {}
  Object.entries(varMap(m)).forEach(([k, o]) => (all[k] = o.v))
  Object.assign(all, ov)
  let s = cmd
  for (let i = 0; i < 6; i++) {
    const n = s.replace(/\$[({]([A-Za-z_][A-Za-z0-9_]*)[)}]/g, (x, v: string) => (v in all ? all[v] : x))
    if (n === s) break
    s = n
  }
  return s.replace(/^[@\-+]+/, '')
}

export interface Param { name: string; def: string; required: boolean }

export function paramsOf(m: Model, n: string, seen = new Set<string>()): Param[] {
  if (seen.has(n) || !m.nodes[n]) return []
  seen.add(n)
  const nd = m.nodes[n]
  const out = new Map<string, Param>()
  const add = (p: Param) => { if (!out.has(p.name)) out.set(p.name, p) }
  const vars = varMap(m)
  if (nd.kind === 'cmd') {
    for (const mm of (nd.cmds || []).join('\n').matchAll(/(?<!\$)\$[({]([A-Za-z_][A-Za-z0-9_]*)[)}]/g)) {
      const v = mm[1]
      if (BUILTIN.has(v)) continue
      const o = vars[v]
      if (!o) add({ name: v, def: '', required: true })
      else if (o.op === '?=') add({ name: v, def: o.v, required: o.v === '' })
    }
  } else if (nd.kind === 'comp') (nd.steps || []).forEach((s) => paramsOf(m, s, seen).forEach(add))
  else if (nd.kind === 'preset' && nd.target) paramsOf(m, nd.target, seen).filter((p) => !(p.name in (nd.args || {}))).forEach(add)
  return [...out.values()]
}

export const argStr = (a: Record<string, string> = {}) =>
  Object.entries(a).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${v}`).join(' ')

export function nodeMake(nd: MakeNode): string {
  const deps = nd.deps?.length ? ' ' + nd.deps.join(' ') : ''
  const head = `${nd.name}:${deps}${nd.desc ? ' ## ' + nd.desc : ''}`
  const lines = [...(nd.comments || []), head]
  if (nd.kind === 'help') lines.push('\t@awk ... $(MAKEFILE_LIST)   # ## 주석으로 목록 출력')
  else if (nd.kind === 'cmd') (nd.cmds || []).forEach((c) => lines.push('\t' + c))
  else if (nd.kind === 'preset') lines.push(`\t$(MAKE) ${nd.target} ${argStr(nd.args)}`)
  else if (nd.mode === 'par') lines.push(`\t$(MAKE) -j ${(nd.steps || []).join(' ')}`)
  else (nd.steps || []).forEach((s) => lines.push(`\t$(MAKE) ${s}`))
  return lines.join('\n')
}

export type HelpSeg = { t: string; c?: 'k' | 'h' | 'd' }
export function helpLines(m: Model): HelpSeg[][] {
  const L: HelpSeg[][] = [[{ t: '사용법: make ' }, { t: '<명령어>', c: 'k' }, { t: ' [변수=값]' }]]
  groupsOf(m).forEach((g) => {
    const ns = m.order.filter((n) => (m.nodes[n].group || null) === g && m.nodes[n].desc)
    if (!ns.length) return
    if (g) { L.push([{ t: '' }]); L.push([{ t: g, c: 'h' }]) }
    ns.forEach((n) => L.push([{ t: '  ' }, { t: n, c: 'k' }, { t: ' ' + '-'.repeat(Math.max(3, 28 - n.length)) + ' ', c: 'd' }, { t: m.nodes[n].desc }]))
  })
  return L
}

export const clone = (m: Model): Model => JSON.parse(JSON.stringify(m))

/** 노드를 추가하거나 바꾼다. 이름이 바뀌면 참조도 함께 바꾼다. */
export function upsertNode(src: Model, orig: string | null, nd: MakeNode): Model {
  const m = clone(src)
  const group = nd.group || null
  if (orig) {
    const i = m.order.indexOf(orig)
    const sameGroup = (m.nodes[orig].group || null) === group
    delete m.nodes[orig]
    m.order.splice(i, 1)
    if (sameGroup) m.order.splice(i, 0, nd.name)
    else insertInGroup(m, nd.name, group)
    if (orig !== nd.name) {
      Object.values(m.nodes).forEach((x) => {
        if (x.kind === 'comp') x.steps = (x.steps || []).map((s) => (s === orig ? nd.name : s))
        if (x.kind === 'preset' && x.target === orig) x.target = nd.name
      })
    }
  } else insertInGroup(m, nd.name, group)
  m.nodes[nd.name] = nd
  return m
}

function insertInGroup(m: Model, name: string, group: string | null) {
  let last = -1
  m.order.forEach((n, i) => { if ((m.nodes[n]?.group || null) === group) last = i })
  if (last < 0) m.order.push(name)
  else m.order.splice(last + 1, 0, name)
}

export function deleteNode(src: Model, name: string): Model {
  const m = clone(src)
  m.order = m.order.filter((x) => x !== name)
  delete m.nodes[name]
  Object.values(m.nodes).forEach((x) => { if (x.kind === 'comp') x.steps = (x.steps || []).filter((s) => s !== name) })
  return m
}
