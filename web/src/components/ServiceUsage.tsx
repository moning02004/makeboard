import { api } from '../api'
import { usePoints } from '../usePoints'
import { TimeChart, type Point } from './TimeChart'

const S1 = 'rgb(var(--series-1))'

// 서비스 화면 위쪽에 펼쳐지는 CPU·메모리 그래프 (그 서비스 컨테이너들의 합계)
export function ServiceUsage({ serviceId }: { serviceId: number }) {
  const points = usePoints(serviceId, (since) => api.serviceMetrics(serviceId, since), 15000) as Point[]
  return (
    <div className="flex-none px-3 lg:pl-0 lg:pr-3.5 pb-3 grid grid-cols-1 md:grid-cols-2 gap-3">
      <TimeChart title="CPU (서버 전체 대비)" unit="pct" points={points} series={[{ key: 'cpu', label: 'CPU', color: S1 }]} />
      <TimeChart title="메모리" unit="bytes" points={points} series={[{ key: 'mem', label: '메모리', color: S1 }]} />
    </div>
  )
}
