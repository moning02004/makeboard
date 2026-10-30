export type Kind = 'help' | 'cmd' | 'comp' | 'preset'
export type NodeType = 'compose' | 'k8s' | 'python' | 'npm' | 'shell' | 'comp' | 'preset' | 'help'

export interface MakeVar { name: string; op: string; v: string; comments?: string[] }

export interface MakeNode {
  name: string
  kind: Kind
  desc: string
  group: string | null
  comments?: string[]
  cmds?: string[]
  deps?: string[]
  mode?: 'seq' | 'par'
  steps?: string[]
  target?: string
  args?: Record<string, string>
  virtual?: boolean
}

export interface Model {
  vars: MakeVar[]
  nodes: Record<string, MakeNode>
  order: string[]
  extra: string[]
  readonly: string | null
}

export interface Metrics {
  cpu?: number; cores?: number; ram?: number; mem_used?: number; mem_total?: number
  disk?: number; disk_used?: number; disk_total?: number; disk_path?: string
  rx?: number; tx?: number; load?: number[]; uptime?: number; jobs?: number; at?: number
  // 에이전트 0.2.0 부터
  cpu_model?: string; sockets?: number; cores_physical?: number; threads?: number
}

export interface ServerBrief {
  id: string
  hostname: string
  environment: string
  version: string
  online: boolean
  metrics: Metrics | null
  last_seen: string | null
  // 설정(MAKEBOARD_BESZEL_URL)이 있을 때만 온다
  beszel_url?: string | null
}

export interface Container { name: string; service: string; state: string; health: string; status: string; cpu?: number; mem?: number }
// cpu 는 서버 전체 대비 %, mem 은 바이트
// compose: 서비스 폴더의 docker compose, k8s: 폴더 이름(또는 Makefile 의 NAMESPACE)과 같은 네임스페이스의 파드
export interface ServiceStatus { kind: 'compose' | 'k8s'; containers: Container[]; error: string | null; usage?: { cpu: number; mem: number } }

export interface ServiceItem { id: number; name: string; path: string; node_count: number; sync_error: string; status: ServiceStatus | null; disk?: number | null }
export interface ServerWithServices extends ServerBrief { services: ServiceItem[]; pending?: boolean }

export interface Pos { x: number; y: number }
export interface Layout { positions?: Record<string, Pos>; favorites?: string[] }

export interface ServiceDetail {
  id: number
  name: string
  path: string
  server: ServerBrief | null
  status: ServiceStatus | null
  makefile: string
  sha: string
  sync_error: string
  synced_at: string | null
  model: Model | null
  layout: Layout
}

export type StepStatus = 'queued' | 'running' | 'ok' | 'failed' | 'stopped' | 'skipped'
export type RunStatus = 'running' | 'ok' | 'failed' | 'stopped'

export interface Step {
  node: string
  status: StepStatus
  exit_code: number | null
  duration: number | null
  cpu_seconds: number | null
  max_rss_kb: number | null
}

export interface RunInfo {
  id: number
  service_id: number
  target: string
  vars: Record<string, string>
  status: RunStatus
  multi: boolean
  started_at: string | null
  finished_at: string | null
  duration: number | null
  triggered_by: string
  commit: string
  steps: Step[]
}

export interface LogLine { seq: number; ts: number; node: string; stream: 'out' | 'err' | 'meta' | 'note'; line: string }
