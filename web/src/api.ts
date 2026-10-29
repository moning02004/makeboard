import type { Layout, Model, RunInfo, ServerWithServices, ServiceDetail } from './types'

// account: 계정으로 로그인했는지 (false 면 CLI 관리자 토큰)
export interface Me { user: string; name: string; admin: boolean; account: boolean }
export interface UserInfo { id: number; username: string; name: string; admin: boolean; created_at: string | null }
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
  login: (username: string, password: string) => req<{ ok: boolean }>('POST', '/api/login', { username, password }),
  changePassword: (current: string, next: string) => req<{ ok: boolean }>('PUT', '/api/me/password', { current, new: next }),
  users: () => req<UserInfo[]>('GET', '/api/users'),
  addUser: (username: string, password: string, name: string, admin: boolean) => req<UserInfo>('POST', '/api/users', { username, password, name, admin }),
  updateUser: (id: number, patch: { password?: string; name?: string; admin?: boolean }) => req<UserInfo>('PUT', `/api/users/${id}`, patch),
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
  stop: (runId: number) => req<{ ok: boolean }>('POST', `/api/runs/${runId}/stop`),
}
