import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { ApiError, api, type CatalogItem, type Me, type Topology } from '../api'
import { Select } from './Select'

const inp = 'w-full h-10 px-3 rounded-xl bg-bg border border-line focus:border-accent outline-none text-[14px] text-fg font-mono'
const COMPOSE_NAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']

/** 구성도의 '노드 추가': 자주 쓰는 서비스를 compose 나 쿠버네티스 yaml 에 넣는다 */
export function AddNode({ serviceId, me, topo, preferFile, onDone, onClose }: {
  serviceId: number; me: Me; topo: Topology; preferFile?: string; onDone: (msg: string, node: { kind: string; name: string }) => void; onClose: () => void
}) {
  const [items, setItems] = useState<CatalogItem[]>([])
  // '직접 입력'은 이미지 대신 Dockerfile 로 빌드할 수 있다 (compose 만)
  const [useBuild, setUseBuild] = useState(false)
  const [buildDir, setBuildDir] = useState('')
  const [dfName, setDfName] = useState('')
  const [port, setPort] = useState('')
  const [itemId, setItemId] = useState('redis')
  const [name, setName] = useState('redis')
  const [nameTouched, setNameTouched] = useState(false)
  const [image, setImage] = useState('')
  const [password, setPassword] = useState('')
  const [connect, setConnect] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reauth, setReauth] = useState(false)
  const [code, setCode] = useState('')

  useEffect(() => { api.catalog().then((c) => setItems(c.items)).catch((e) => setError((e as Error).message)) }, [])
  const item = items.find((i) => i.id === itemId)
  useEffect(() => {
    if (!item) return
    setImage(item.image)
    if (!nameTouched) setName(item.id === 'custom' ? '' : item.id)
  }, [item, nameTouched])

  // 넣을 곳: 구성도에 있는 compose 파일들, 없으면 새 docker-compose.yml. 쿠버네티스는 새 파일
  const composeFiles = useMemo(() => {
    const fromNodes = topo.nodes.filter((n) => n.kind === 'compose' && n.file).map((n) => n.file!)
    const byName = Object.keys(topo.files).filter((f) => COMPOSE_NAMES.includes(f.split('/').pop()!))
    return [...new Set([...fromNodes, ...byName])]
  }, [topo])
  const k8sDir = useMemo(() => {
    const f = topo.nodes.find((n) => n.file && n.kind !== 'compose' && n.kind !== 'volume')?.file
    return f && f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : ''
  }, [topo])
  const building = itemId === 'custom' && useBuild
  const targets = [
    ...(composeFiles.length ? composeFiles : ['docker-compose.yml']).map((f) => ({
      value: `compose:${f}`, label: `compose · ${f}`, description: composeFiles.includes(f) ? '서비스로 덧붙입니다' : '새 파일을 만듭니다' })),
    { value: 'k8s', label: `쿠버네티스 · ${k8sDir}${name || '이름'}.yaml`, description: 'Service·Secret·StatefulSet(또는 Deployment)을 새 파일로' },
  ].filter((t) => !(building && t.value === 'k8s'))
  // 기본: compose 파일이 있으면 거기, 없고 쿠버네티스 리소스가 있으면 쿠버네티스, 둘 다 없으면 새 compose
  const hasK8s = topo.nodes.some((n) => n.file && !['compose', 'volume'].includes(n.kind))
  // 구성도에서 고른 파일이 있으면 그쪽을 기본으로: compose 파일이면 거기, 쿠버네티스 파일이면 쿠버네티스
  const initial = preferFile && composeFiles.includes(preferFile) ? `compose:${preferFile}`
    : preferFile ? 'k8s' : composeFiles.length || !hasK8s ? targets[0].value : 'k8s'
  const [target, setTarget] = useState(initial)
  useEffect(() => { if (building && target === 'k8s') setTarget(targets[0].value) }, [building, target, targets])
  const isCompose = target.startsWith('compose:')
  const composeServices = isCompose ? topo.nodes.filter((n) => n.kind === 'compose' && n.file === target.slice(8)).map((n) => n.name) : []
  const exists = topo.nodes.some((n) => n.name === name && (isCompose ? n.kind === 'compose' : !n.missing))

  const run = async () => {
    setBusy(true); setError('')
    try {
      const r = await api.addNode(serviceId, {
        item: itemId, name: name.trim(), image: building ? '' : image.trim(), password,
        build: building ? (buildDir.trim() || `./${name.trim()}`) : '', dockerfile: building ? dfName.trim() : '',
        port: itemId === 'custom' && port.trim() ? Number(port) : null,
        target: isCompose ? target : `k8s:${k8sDir}${name.trim()}.yaml`, connect: isCompose ? connect : [],
      })
      const [kind, n] = r.node.split(':')
      onDone(`${n} 을(를) 추가했습니다 · ${r.file}`, { kind, name: n })
    } catch (e) {
      if (e instanceof ApiError && e.status === 428) { setReauth(true); setCode('') } else setError((e as Error).message)
    } finally { setBusy(false) }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void run() }
  const submitReauth = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await api.reauth(me.otp.enabled ? { code: code.trim() } : { password: code })
      setReauth(false)
      await run()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="p-6 flex flex-col gap-4">
      <div>
        <h3 id="mTitle" className="text-[17px] font-semibold">노드 추가</h3>
        <p className="text-[13px] text-muted mt-1">자주 쓰는 구성을 골라 yaml 에 넣습니다. 파일의 다른 내용은 그대로 둡니다.</p>
      </div>
      {reauth ? (
        <form onSubmit={submitReauth} className="flex flex-col gap-2 rounded-xl bg-accentsoft/60 border border-accent/30 p-3.5">
          <span className="text-[13px] font-medium">비밀번호를 .env 에 넣으려면 한 번 더 인증하세요</span>
          <div className="flex gap-2">
            <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus type={me.otp.enabled ? 'text' : 'password'}
              aria-label={me.otp.enabled ? '인증 코드' : '비밀번호'} placeholder={me.otp.enabled ? '인증 앱의 6자리 코드' : '비밀번호'}
              autoComplete={me.otp.enabled ? 'one-time-code' : 'current-password'} className={`${inp} h-9 flex-1`} />
            <button type="button" onClick={() => setReauth(false)} className="h-9 px-3 rounded-full text-[13px] text-muted hover:bg-hover">취소</button>
            <button type="submit" disabled={busy || !code.trim()} className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] disabled:opacity-50">확인</button>
          </div>
          {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
        </form>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">종류</span>
            <Select label="종류" value={itemId} onChange={(v) => { setItemId(v); setNameTouched(false) }}
              options={items.map((i) => ({ value: i.id, label: i.name, description: i.description }))} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-[12px] text-muted">이름
              <input className={inp} value={name} onChange={(e) => { setName(e.target.value.toLowerCase()); setNameTouched(true) }} spellCheck={false} autoComplete="off" placeholder="cache" />
            </label>
            {!building && (
              <label className="flex flex-col gap-1.5 text-[12px] text-muted">이미지
                <input className={inp} value={image} onChange={(e) => setImage(e.target.value)} spellCheck={false} autoComplete="off" placeholder="redis:7" />
              </label>
            )}
          </div>
          {itemId === 'custom' && <>
            <div role="radiogroup" aria-label="실행 방식" className="flex gap-0.5 p-0.5 rounded-full bg-hover text-[12px] self-start">
              {([[false, '이미지 사용'], [true, 'Dockerfile로 빌드']] as const).map(([v, label]) => (
                <button key={label} type="button" role="radio" aria-checked={useBuild === v} onClick={() => setUseBuild(v)}
                  className={`h-7 px-3 rounded-full ${useBuild === v ? 'bg-accent text-onaccent font-semibold' : 'text-muted hover:text-fg'}`}>{label}</button>
              ))}
            </div>
            {useBuild && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5 text-[12px] text-muted">빌드 폴더 <span className="text-faint">compose 파일 기준</span>
                  <input className={inp} value={buildDir} onChange={(e) => setBuildDir(e.target.value)} spellCheck={false} autoComplete="off" placeholder={`./${name || 'app'}`} />
                </label>
                <label className="flex flex-col gap-1.5 text-[12px] text-muted">Dockerfile 이름 <span className="text-faint">그 폴더 안</span>
                  <input className={inp} value={dfName} onChange={(e) => setDfName(e.target.value)} spellCheck={false} autoComplete="off" placeholder="Dockerfile" />
                </label>
              </div>
            )}
            <label className="flex flex-col gap-1.5 text-[12px] text-muted sm:w-1/2">포트 <span className="text-faint">선택</span>
              <input className={inp} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="8000" />
            </label>
          </>}
          {item?.password && (
            <label className="flex flex-col gap-1.5 text-[12px] text-muted">비밀번호 <span className="text-faint">비우면 자동으로 만듭니다 · compose 는 .env, 쿠버네티스는 Secret 에 저장</span>
              <input className={inp} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
          )}
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">넣을 곳</span>
            <Select label="넣을 곳" value={target} onChange={(v) => { setTarget(v); setConnect([]) }} options={targets} />
          </div>
          {isCompose && composeServices.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-muted">이 서비스가 먼저 켜져야 하는 서비스 <span className="text-faint">depends_on 에 더합니다</span></span>
              <div className="flex flex-wrap gap-1.5">
                {composeServices.map((s) => (
                  <button key={s} type="button" aria-pressed={connect.includes(s)} onClick={() => setConnect((c) => (c.includes(s) ? c.filter((x) => x !== s) : [...c, s]))}
                    className={`h-8 px-3 rounded-full text-[12.5px] font-mono border ${connect.includes(s) ? 'border-accent bg-accentsoft text-accent' : 'border-line text-muted hover:bg-hover'}`}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {exists && <p className="text-[12px] text-warn">'{name}' 이(가) 이미 있습니다. 다른 이름을 쓰세요.</p>}
          {error && <p role="alert" className="text-[13px] text-fail">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="h-9 px-4 rounded-full text-[13px] text-muted hover:bg-hover">취소</button>
            <button type="submit" disabled={busy || !item || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name.trim()) || (!building && !image.trim()) || exists
              || (building && !!dfName.trim() && !/^([Dd]ockerfile(\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+\.[Dd]ockerfile)$/.test(dfName.trim()))}
              className="h-9 px-4 rounded-full bg-accent text-onaccent text-[13px] disabled:opacity-50">{busy ? '추가하는 중…' : '추가'}</button>
          </div>
        </form>
      )}
    </div>
  )
}
