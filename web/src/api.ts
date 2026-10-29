import type { Layout, Model, RunInfo, ServerWithServices, ServiceDetail } from './types'

// account: 계정으로 로그인했는지 (false 면 CLI 관리자 토큰)
// edit: Makefile·yaml 편집 가능(편집자·관리자). otp.setup_required 면 2단계 인증을 등록해야 다른 기능을 쓸 수 있다
export interface Me { user: string; name: string; admin: boolean; edit: boolean; account: boolean; otp: { enabled: boolean; required: boolean; setup_required: boolean }; elevated_until?: number }
export interface EnvFile { path: string; sha: string; keys: { key: string; empty: boolean }[] }
export interface AuditRow { id: number; at: string | null; user: string; action: string; target: string; ip: string }
export type Role = 'run' | 'edit' | 'admin'
export interface UserInfo { id: number; username: string; name: string; role: Role; admin: boolean; otp: boolean; created_at: string | null }
export interface TopoNode {
  id: string; kind: string; name: string; rank: number; summary: string[][]
  file?: string; text?: string; editable?: boolean; readonly?: string | null; missing?: boolean; template?: boolean
  status?: { ready: number; total: number; tone: 'ok' | 'warn' | 'off' }
}
// 선 종류: start 먼저 켜짐 → 나중, traffic 요청 흐름, ref 설정·볼륨 사용·가리킴
export interface TopoEdge { from: string; to: string; label: string; kind: 'start' | 'traffic' | 'ref' }
export interface Topology { nodes: TopoNode[]; edges: TopoEdge[]; positions: Record<string, { x: number; y: number }>; errors: string[]; files: Record<string, string> }
export interface CatalogItem { id: string; name: string; description: string; image: string; port: number | null; password: boolean }
export interface FileRev { id: number; sha: string; author: string; note: string; size?: number; created_at: string | null }
export interface SettingInfo { value: string; env: string; saved: boolean; help: string }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `요청이 실패했습니다 (${res.status})`
    try {
      const j = await res.json()
      if (typeof j.detail === 'string') msg = j.detail
      else if (Array.isArray(j.detail)) msg = j.detail.map((d: { msg: string }) => d.msg).join(', ')
    } catch { /* 본문 없음 */ }
    throw new ApiError(res.status, msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  me: () => req<Me>('GET', '/api/me'),
  login: (username: string, password: string) => req<{ ok: boolean; otp_required?: boolean; ticket?: string }>('POST', '/api/login', { username, password }),
  loginOtp: (ticket: string, code: string) => req<{ ok: boolean; recovery_left: number }>('POST', '/api/login/otp', { ticket, code }),
  otpSetup: () => req<{ secret: string; uri: string; qr: string }>('POST', '/api/me/otp/setup'),
  otpEnable: (code: string) => req<{ recovery_codes: string[] }>('POST', '/api/me/otp/enable', { code }),
  otpDisable: (code: string) => req<{ ok: boolean }>('POST', '/api/me/otp/disable', { code }),
  otpRecovery: (code: string) => req<{ recovery_codes: string[] }>('POST', '/api/me/otp/recovery', { code }),
  changePassword: (current: string, next: string) => req<{ ok: boolean }>('PUT', '/api/me/password', { current, new: next }),
  users: () => req<UserInfo[]>('GET', '/api/users'),
  addUser: (username: string, password: string, name: string, role: Role) => req<UserInfo>('POST', '/api/users', { username, password, name, role }),
  updateUser: (id: number, patch: { password?: string; name?: string; role?: Role; reset_otp?: boolean }) => req<UserInfo>('PUT', `/api/users/${id}`, patch),
  deleteUser: (id: number) => req<{ ok: boolean }>('DELETE', `/api/users/${id}`),
  logout: () => req<{ ok: boolean }>('POST', '/api/logout'),
  servers: () => req<ServerWithServices[]>('GET', '/api/servers'),
  service: (id: number) => req<ServiceDetail>('GET', `/api/services/${id}`),
  sync: (id: number) => req<ServiceDetail>('POST', `/api/services/${id}/sync`),
  saveModel: (id: number, model: Model, sha: string) => req<ServiceDetail>('PUT', `/api/services/${id}/model`, { model, sha }),
  saveLayout: (id: number, layout: Layout) => req<Layout>('PUT', `/api/services/${id}/layout`, layout),
  run: (id: number, target: string, vars: Record<string, string>) => req<{ run_id: number }>('POST', `/api/services/${id}/runs`, { target, vars }),
  runs: (id: number) => req<RunInfo[]>('GET', `/api/services/${id}/runs?limit=20`),
  agentConfig: () => req<{ public_url: string }>('GET', '/api/agents/config'),
  addAgent: (body: { name: string; environment: string; scan: string[]; public_url: string; run_as: string; kubeconfig: string; replace: boolean }) =>
    req<{ agent_id: string; command: string }>('POST', '/api/agents', body),
  installOptions: (id: string) => req<{ scan: string[]; kubeconfig: string; run_as: string }>('GET', `/api/servers/${encodeURIComponent(id)}/install`),
  deleteServer: (id: string, uninstall: boolean) => req<{ ok: boolean; agent: { result: 'removed' | 'manual' | 'unconfirmed' | 'offline' | 'kept'; message: string } }>('DELETE', `/api/servers/${encodeURIComponent(id)}?uninstall=${uninstall}`),
  templates: () => req<{ id: string; name: string; description: string; content: string }[]>('GET', '/api/templates'),
  initMakefile: (id: number, template: string) => req<ServiceDetail>('POST', `/api/services/${id}/init`, { template }),
  // since: 이미 가진 마지막 점의 시각. 그 뒤의 점만 받는다
  serverMetrics: (id: string, since = 0) => req<{ points: { t: number; cpu?: number; ram?: number; disk?: number; rx?: number; tx?: number }[] }>('GET', `/api/servers/${encodeURIComponent(id)}/metrics?since=${since}`),
  serviceMetrics: (id: number, since = 0) => req<{ points: { t: number; cpu?: number; mem?: number }[] }>('GET', `/api/services/${id}/metrics?since=${since}`),
  settings: () => req<Record<string, SettingInfo>>('GET', '/api/settings'),
  // null 은 .env 값으로 되돌리기
  saveSettings: (changes: Record<string, string | null>) => req<Record<string, SettingInfo>>('PUT', '/api/settings', changes),
  // 서비스 폴더의 yaml 파일 (에이전트 0.4.0 이상)
  files: (id: number) => req<{ path: string; size: number }[]>('GET', `/api/services/${id}/files`),
  file: (id: number, path: string) => req<{ path: string; content: string; sha: string; readonly: string | null }>('GET', `/api/services/${id}/files/content?path=${encodeURIComponent(path)}`),
  saveFile: (id: number, path: string, content: string, sha: string) => req<{ sha: string; changed: boolean }>('PUT', `/api/services/${id}/files/content`, { path, content, sha }),
  fileHistory: (id: number, path: string) => req<FileRev[]>('GET', `/api/services/${id}/files/history?path=${encodeURIComponent(path)}`),
  fileRevision: (id: number, rev: number) => req<FileRev & { content: string }>('GET', `/api/services/${id}/files/history/${rev}`),
  revertFile: (id: number, rev: number, sha: string) => req<{ sha: string; changed: boolean }>('POST', `/api/services/${id}/files/revert`, { rev_id: rev, sha }),
  // 서비스 폴더의 compose·쿠버네티스 yaml 구성도
  topology: (id: number) => req<Topology>('GET', `/api/services/${id}/topology`),
  catalog: () => req<{ items: CatalogItem[] }>('GET', '/api/catalog'),
  addNode: (id: number, body: { item: string; name: string; image: string; password: string; target: string; connect: string[]; build?: string; dockerfile?: string; port?: number | null }) =>
    req<{ file: string; node: string }>('POST', `/api/services/${id}/topology/add`, body),
  saveTopoPositions: (id: number, positions: Record<string, { x: number; y: number }>) => req<{ positions: Record<string, { x: number; y: number }> }>('PUT', `/api/services/${id}/topology/positions`, { positions }),
  saveTopoNode: (id: number, nodeId: string, sha: string, text: string | null) => req<{ changed: boolean }>('PUT', `/api/services/${id}/topology/node`, { id: nodeId, sha, text }),
  // 환경변수: 목록은 키만, 값 보기·수정은 다시 인증(428 이면 reauth 후 다시)
  envList: (id: number) => req<{ files: EnvFile[]; can_edit: boolean; elevated_until: number }>('GET', `/api/services/${id}/env`),
  envReveal: (id: number, path: string, key: string) => req<{ value: string }>('POST', `/api/services/${id}/env/reveal`, { path, key }),
  envSet: (id: number, path: string, key: string, value: string | null, sha: string) => req<{ sha: string }>('PUT', `/api/services/${id}/env`, { path, key, value, sha }),
  reauth: (body: { code?: string; password?: string }) => req<{ until: number }>('POST', '/api/me/reauth', body),
  audit: () => req<AuditRow[]>('GET', '/api/audit'),
  stop: (runId: number) => req<{ ok: boolean }>('POST', `/api/runs/${runId}/stop`),
}
