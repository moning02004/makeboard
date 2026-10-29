import type { Layout, Model, RunInfo, ServerWithServices, ServiceDetail } from './types'

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
  me: () => req<{ user: string }>('GET', '/api/me'),
  login: (token: string) => req<{ ok: boolean }>('POST', '/api/login', { token }),
  logout: () => req<{ ok: boolean }>('POST', '/api/logout'),
  servers: () => req<ServerWithServices[]>('GET', '/api/servers'),
  service: (id: number) => req<ServiceDetail>('GET', `/api/services/${id}`),
  sync: (id: number) => req<ServiceDetail>('POST', `/api/services/${id}/sync`),
  saveModel: (id: number, model: Model, sha: string) => req<ServiceDetail>('PUT', `/api/services/${id}/model`, { model, sha }),
  saveLayout: (id: number, layout: Layout) => req<Layout>('PUT', `/api/services/${id}/layout`, layout),
  run: (id: number, target: string, vars: Record<string, string>) => req<{ run_id: number }>('POST', `/api/services/${id}/runs`, { target, vars }),
  runs: (id: number) => req<RunInfo[]>('GET', `/api/services/${id}/runs?limit=20`),
  agentConfig: () => req<{ public_url: string }>('GET', '/api/agents/config'),
  addAgent: (body: { name: string; environment: string; scan: string[]; public_url: string; run_as: string }) =>
    req<{ agent_id: string; command: string }>('POST', '/api/agents', body),
  deleteServer: (id: string, uninstall: boolean) => req<{ ok: boolean; agent: { result: 'removed' | 'manual' | 'unconfirmed' | 'offline' | 'kept'; message: string } }>('DELETE', `/api/servers/${encodeURIComponent(id)}?uninstall=${uninstall}`),
  templates: () => req<{ id: string; name: string; description: string; content: string }[]>('GET', '/api/templates'),
  initMakefile: (id: number, template: string) => req<ServiceDetail>('POST', `/api/services/${id}/init`, { template }),
  serverMetrics: (id: string) => req<{ points: { t: number; cpu?: number; ram?: number; disk?: number; rx?: number; tx?: number }[] }>('GET', `/api/servers/${encodeURIComponent(id)}/metrics`),
  serviceMetrics: (id: number) => req<{ points: { t: number; cpu?: number; mem?: number }[] }>('GET', `/api/services/${id}/metrics`),
  stop: (runId: number) => req<{ ok: boolean }>('POST', `/api/runs/${runId}/stop`),
}
