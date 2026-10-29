#!/usr/bin/env bash
# Makeboard 로컬 데모: 서버 + 웹 + 에이전트 + 예제 서비스를 한 번에 띄운다.
#
#   ./scripts/demo.sh            # http://127.0.0.1:8000
#   ./scripts/demo.sh --reset    # 데모 DB 와 예제 서비스를 처음 상태로 되돌리고 띄우기
#   DEMO_PORT=8100 ./scripts/demo.sh
#
# 필요한 것: Python 3.11 이상, Node.js(웹을 처음 빌드할 때만). Docker 와 PostgreSQL 은 필요 없다(SQLite).
# 모든 데이터는 .demo/ 에 두고, 예제 서비스도 거기에 복사해서 쓰므로 저장소의 파일은 바뀌지 않는다.
# 예제 Makefile 은 메시지만 출력하고, api 서비스의 kubectl 은 클러스터에 접속하지 않는 데모용 가짜다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${DEMO_DIR:-$ROOT/.demo}"
PORT="${DEMO_PORT:-8000}"
URL="http://127.0.0.1:$PORT"
ADMIN_TOKEN="demo-admin-token-not-for-production"
PASSWORD="demo1234"

say() { printf '\033[1;35m[demo]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[demo]\033[0m %s\n' "$*" >&2; exit 1; }

if [[ "${1:-}" == "--reset" ]]; then
  say "데모 DB 와 예제 서비스를 지웁니다"
  rm -rf "$DEMO/services" "$DEMO/makeboard.db"
fi
mkdir -p "$DEMO"

# ---- Python
PY="$(command -v python3 || true)"
[[ -n "$PY" ]] || die "python3 가 필요합니다 (3.11 이상)"
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "Python 3.11 이상이 필요합니다 (지금 $("$PY" -V))"
VENV="$DEMO/venv"
REQS=("$ROOT/server/requirements.txt" "$ROOT/agent/requirements.txt")
STAMP="$(cat "${REQS[@]}" | cksum | cut -d' ' -f1)"
if [[ ! -x "$VENV/bin/python" || "$(cat "$VENV/.stamp" 2>/dev/null)" != "$STAMP" ]]; then
  say "Python 패키지를 설치합니다 ($VENV)"
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install -q --disable-pip-version-check -r "${REQS[0]}" -r "${REQS[1]}"
  echo "$STAMP" > "$VENV/.stamp"
fi

# ---- 웹 (빌드한 화면을 서버가 함께 제공한다)
if [[ ! -f "$ROOT/web/dist/index.html" ]]; then
  command -v npm >/dev/null || die "웹을 빌드하려면 Node.js(npm)가 필요합니다"
  say "웹을 빌드합니다"
  (cd "$ROOT/web" && { [[ -d node_modules ]] || npm ci --no-audit --no-fund; } && npm run build >/dev/null)
fi

# ---- 예제 서비스
if [[ ! -d "$DEMO/services" ]]; then
  cp -R "$ROOT/examples/demo/services" "$DEMO/services"
fi

"$VENV/bin/python" - "$PORT" 2>/dev/null <<'PY' || die "포트 $PORT 를 이미 쓰고 있습니다. DEMO_PORT=$((PORT + 100)) ./scripts/demo.sh 처럼 바꿔 보세요"
import socket, sys
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # 방금 끈 데모의 TIME_WAIT 는 쓰는 중이 아니다 (uvicorn 과 같은 기준)
s.bind(("127.0.0.1", int(sys.argv[1])))
PY

# ---- 서버
PIDS=()
cleanup() {
  trap - INT TERM EXIT
  say "끄는 중…"
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

say "서버를 띄웁니다 ($URL)"
(
  cd "$ROOT/server"
  # server/.env 가 있어도 아래 값이 우선한다
  MAKEBOARD_ADMIN_TOKEN="$ADMIN_TOKEN" \
  MAKEBOARD_ADMIN_USER=admin MAKEBOARD_ADMIN_PASSWORD="$PASSWORD" \
  MAKEBOARD_OTP_REQUIRED=false \
  MAKEBOARD_DATABASE_URL="sqlite+aiosqlite:///$DEMO/makeboard.db" \
  MAKEBOARD_AGENT_TOKENS="demo-local:demo-agent-token" \
  MAKEBOARD_WEB_DIST="$ROOT/web/dist" \
  MAKEBOARD_PUBLIC_URL="$URL" \
  MAKEBOARD_COOKIE_SECURE=false \
  exec "$VENV/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$PORT"
) > "$DEMO/server.log" 2>&1 &
PIDS+=($!)

for _ in $(seq 1 40); do
  curl -fs "$URL/healthz" >/dev/null 2>&1 && break
  kill -0 "${PIDS[0]}" 2>/dev/null || die "서버가 시작하지 못했습니다. $DEMO/server.log 를 보세요"
  sleep 0.25
done
curl -fs "$URL/healthz" >/dev/null || die "서버가 응답하지 않습니다. $DEMO/server.log 를 보세요"

# 실행 권한만 있는 사용자 (이미 있으면 그대로)
curl -fs -o /dev/null -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"username\":\"viewer\",\"name\":\"보기 전용\",\"password\":\"$PASSWORD\",\"role\":\"run\"}" "$URL/api/users" || true

# ---- 에이전트 (예제 서비스 폴더를 본다. api 서비스용 가짜 kubectl 을 PATH 앞에 둔다)
cat > "$DEMO/agent.toml" <<EOF
server = "ws://127.0.0.1:$PORT/ws/agent"
agent_id = "demo-local"
token = "demo-agent-token"
environment = "dev"
heartbeat_seconds = 3
scan = ["$DEMO/services"]
EOF
PATH="$ROOT/examples/demo/bin:$PATH" "$VENV/bin/python" "$ROOT/agent/makeboard_agent.py" -c "$DEMO/agent.toml" \
  > "$DEMO/agent.log" 2>&1 &
PIDS+=($!)

cat <<EOF

  Makeboard 데모가 떠 있습니다 → $URL

  관리자       admin  / $PASSWORD
  실행 권한    viewer / $PASSWORD

  둘러볼 것
    · demo-local 서버 → shop: deploy 를 실행해 단계별 로그 보기, 오른쪽 위 '파일'에서 config.yaml 고치고 되돌리기
    · api: '구성'에서 쿠버네티스 구성도와 '+ 노드 추가', 파드 상태와 CPU·메모리 (데모용 가짜 kubectl)
    · shop: '환경변수'에서 .env 값 보기·수정 (한 번 더 인증, 설정 → 기록에 남음)
    · batch: check(병렬), slow(중지 버튼), broken(실패), backfill(인자 입력)
    · new-service: Makefile 이 없는 서비스 → 템플릿으로 만들기
    · 설정 → 사용자 / 내 계정: 권한과 2단계 인증 (데모는 2단계 인증이 선택)

  로그: $DEMO/server.log, $DEMO/agent.log
  끄기: Ctrl+C   ·   처음 상태로: ./scripts/demo.sh --reset

EOF
wait
