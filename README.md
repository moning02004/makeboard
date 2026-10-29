# Makeboard

서버마다 흩어진 Makefile을 웹에서 카드로 보고 실행하는 도구입니다.

- **실행**: Makefile 타깃 하나하나가 명령어 카드가 됩니다. 카드를 눌러 실행하면 로그가 실시간으로 나옵니다.
- **복합 명령어**: 여러 명령어를 순차 또는 병렬로 묶어 실행합니다.
- **인자와 프리셋**: `SCRIPT=...` 같은 인자를 넘겨 실행하고, 자주 쓰는 값은 프리셋으로 저장합니다.
- **그룹과 help**: 명령어를 그룹으로 묶고, `make help` 출력이 주석에서 자동으로 만들어집니다.
- **원격 실행**: 각 서버의 에이전트가 중앙 서버로 먼저 연결하는 구조라서, 대상 서버에는 들어오는 포트를 열지 않아도 됩니다.
- **원본은 Makefile**: 웹에서 편집한 내용은 그 서버의 Makefile에 그대로 저장됩니다. 터미널에서도 똑같이 `make deploy`로 쓸 수 있습니다.

```
 브라우저 ──HTTPS──▶ 중앙 서버 (FastAPI + PostgreSQL + 웹 화면)
                         ▲  WebSocket (에이전트가 먼저 연결, wss 권장)
          ┌──────────────┼──────────────┐
     [에이전트]       [에이전트]       [에이전트]
     prod-app-01      k3s-cluster      dev-01
     make 실행        kubectl 실행     ...
```

## 폴더 구성

| 경로 | 내용 |
|---|---|
| `server/` | 중앙 서버 (FastAPI). Makefile 파싱/생성, 에이전트 연결, 실행 관리, API, SSE 로그 스트림 |
| `web/` | 화면 (React + TypeScript + Tailwind) |
| `agent/` | 에이전트 (Python 파일 하나). 대상 서버마다 설치 |
| `examples/demo/` | 바로 돌려볼 수 있는 예시 Makefile |

---

## 1. 중앙 서버 실행 (docker compose)

```bash
cp .env.example .env
# .env 에 값 채우기. 토큰은 아래 명령으로 만든다
openssl rand -hex 32

docker compose up -d --build
```

`http://<서버>:8000` 에 접속해 `MAKEBOARD_ADMIN_TOKEN` 값으로 로그인합니다.

운영에서는 앞단에 TLS 리버스 프록시를 두고 `MAKEBOARD_COOKIE_SECURE=true`로 설정하세요. 에이전트 연결(`/ws/agent`)도 같은 주소로 들어오므로 WebSocket 업그레이드를 허용해야 합니다.

- Caddy: 추가 설정이 필요 없습니다.
- nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`를 추가합니다.
- 로그 스트림(SSE)이 끊기지 않도록 버퍼링을 끕니다. 서버가 `X-Accel-Buffering: no`를 보내므로 nginx는 자동으로 처리됩니다.

> 실행 상태를 메모리에서 관리하기 때문에 서버 프로세스(uvicorn 워커)는 **1개**로 운영합니다. 여러 개로 늘리려면 `server/app/hub.py`를 Redis pub/sub로 바꿔야 합니다.

## 2. 에이전트 설치 (관리할 서버마다)

에이전트는 Docker로만 설치합니다. 대상 서버에는 Docker만 있으면 됩니다.

1. 웹의 **+ 서버 추가**에서 서버 이름과 서비스 폴더(기본 `/home/ubuntu/services`), 실행 계정을 입력합니다.
2. 만들어진 명령어 한 줄을 대상 서버의 터미널에 붙여넣습니다.

```bash
docker build -t makeboard-agent http://<중앙서버>:8000/agent/docker.tar.gz && \
{ docker rm -f makeboard-agent; docker run -d --name makeboard-agent --restart unless-stopped --network host \
    --user ... --group-add ... -v /var/run/docker.sock:/var/run/docker.sock -v /home/ubuntu/services:/home/ubuntu/services \
    -e MAKEBOARD_SERVER=ws://<중앙서버>:8000/ws/agent -e MAKEBOARD_AGENT_ID=... -e MAKEBOARD_AGENT_TOKEN=... \
    -e MAKEBOARD_SCAN=/home/ubuntu/services makeboard-agent; }
```

중앙 서버가 빌드 컨텍스트(`/agent/docker.tar.gz`)를 내려주므로 레지스트리나 저장소 복사가 필요 없습니다. 같은 명령어를 다시 실행하면 최신 에이전트로 바뀝니다.

- **서비스**: 서비스 폴더 바로 아래 폴더는 모두 서비스가 됩니다. Makefile이 없으면 웹에서 템플릿으로 만들 수 있고, 새 폴더를 만들면 30초 안에 나타납니다.
- **실행 환경**: 레시피는 컨테이너 안에서 실행됩니다. 이미지에는 `make`, `git`, `curl`, `ssh`, `docker`, `docker compose`가 들어 있고, `docker` 명령은 마운트한 소켓으로 그 서버의 Docker를 씁니다. `kubectl` 같은 다른 도구가 필요하면 `agent/Dockerfile`에 추가하세요.
- **같은 경로 마운트**: 서비스 폴더는 호스트와 같은 경로로 마운트합니다. 그래야 `docker compose`의 상대 경로 볼륨이 호스트에서도 맞습니다.
- **실행 계정**: 레시피는 "실행 계정"으로 실행되고 만드는 파일도 그 계정 소유가 됩니다. 비우면 첫 서비스 폴더의 소유자 UID/GID(`--user`)로 띄우고, docker 소켓의 그룹(`--group-add`)을 더합니다. `root`를 넣으면 root로 돕니다. docker 소켓을 쓸 수 있으면 사실상 호스트 root 권한이라는 점에 유의하세요.
- **호스트 네트워크**: `--network host`로 띄워서 호스트 이름과 리소스 값이 컨테이너가 아니라 그 서버 기준으로 잡힙니다.

### 제거

웹에서 서버의 휴지통 버튼을 누르면 서버와 서비스, 실행 기록이 지워지고 토큰이 무효가 됩니다. **서버 에이전트도 삭제**에 체크하면, 연결돼 있는 에이전트에게 자기 컨테이너를 지우라고 보내고 연결이 끊기는 것으로 결과를 확인합니다. 오프라인이거나 자동으로 지우지 못하면 직접 지울 명령어를 보여줍니다.

```bash
docker rm -f makeboard-agent && docker rmi makeboard-agent
```

서비스 폴더와 Makefile은 그대로 남습니다. `.env`의 `MAKEBOARD_AGENT_TOKENS`로 등록한 서버는 웹에서 지울 수 없습니다. `.env`에서 지우고 서버를 재시작하세요.

## 3. 로컬 개발

```bash
# 서버
cd server && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env
uvicorn app.main:app --reload --port 8000

# 웹 (다른 터미널) → http://localhost:5173
cd web && npm install && npm run dev

# 에이전트 (다른 터미널) - examples/demo 를 서비스로 등록
pip install -r agent/requirements.txt
python3 agent/makeboard_agent.py -c agent/agent.dev.toml -v
```

웹에서 `dev-admin-token-please-change`로 로그인하면 `dev-local / demo`가 보입니다. 테스트는 `cd server && pytest`로 돌립니다.

---

## Makefile 규칙

웹 화면은 아래 규칙으로 Makefile을 읽고 씁니다. 손으로 쓴 Makefile도 이 규칙을 따르면 그대로 카드가 됩니다.

```makefile
NS ?= prod          # ?= 변수는 실행할 때 바꿀 수 있는 인자 (기본값 prod)
SCRIPT ?=           # 기본값이 없으면 필수 인자

##@ 배포                                   ← 그룹 (화면에서 섹션으로 묶임)
pull: ## 최신 이미지 받기                   ← ## 뒤가 설명. help 출력과 노드에 표시
	docker compose pull backend

deploy: ## 전체 배포                        ← 복합 명령어 (순차)
	$(MAKE) pull
	$(MAKE) migrate
	$(MAKE) up

check: ## 테스트와 린트를 동시에             ← 복합 명령어 (병렬)
	$(MAKE) -j test lint

##@ 백필
backfill: ## 백필 스크립트 (SCRIPT=이름)
	docker compose run --rm backend python3 manage.py runscript $(SCRIPT)
backfill-rename-users: ## 사용자 이름 형식 변경   ← 프리셋 (인자 고정)
	$(MAKE) backfill SCRIPT=backfill_rename_users
```

| 종류 | 쓰는 법 | 웹에서 |
|---|---|---|
| 명령어 | 레시피에 명령을 직접 씀 | 단독 실행. `$(VAR)`가 있으면 입력칸이 생김 |
| 순차 복합 | `$(MAKE) a` 를 여러 줄, 또는 `deploy: a b c` (레시피 없음) | 앞이 끝나야 다음 실행, 실패하면 중단 |
| 병렬 복합 | `$(MAKE) -j a b` 한 줄 | 동시에 실행. 로그에 노드 이름이 붙음 |
| 프리셋 | `$(MAKE) target VAR=값` 한 줄 | 인자가 고정된 바로가기 |
| help | 자동 | 항상 있음. 웹에서 저장하면 파일에 `.DEFAULT_GOAL := help`와 함께 들어감 |

웹에서 저장할 때 알아둘 점이 있습니다.

- **백업과 덮어쓰기 방지**: 저장하기 전 원래 파일은 같은 폴더의 `Makefile.makeboard.bak`에 남습니다. 그사이 서버에서 Makefile이 바뀌었다면 덮어쓰지 않고 다시 불러오라고 알립니다.
- **보존되는 내용**: 타깃 바로 위의 주석, 변수, 패턴 규칙(`%.o: %.c`), `export` 같은 줄은 그대로 남습니다. 그 외 위치의 자유 주석은 정리됩니다.
- **읽기 전용 파일**: `ifeq`, `include` 같은 조건문이 있는 Makefile은 읽기 전용으로 열립니다. 실행은 가능하지만 웹에서 편집할 수는 없습니다.
- **git**: Makefile이 git으로 관리된다면 웹에서 바꾼 뒤 서버에서 커밋하는 흐름을 정해두세요.

## 실행 방식

- **노드별 실행**: 복합 명령어와 프리셋은 중앙 서버가 펼쳐서, 실제 명령어 노드만 에이전트에게 `make <타깃> VAR=값`으로 보냅니다. 결과는 터미널에서 `make deploy`를 실행한 것과 같습니다. 대신 노드마다 상태, 소요 시간, CPU 시간, 최대 메모리가 따로 기록됩니다.
- **로그 저장**: 로그는 DB에 저장되므로 지난 실행도 다시 볼 수 있습니다. 패널의 실행 로그 탭에서 고르면 됩니다.
- **중지**: 중지 버튼을 누르면 make와 그 자식 프로세스 전체에 SIGTERM을 보내고, 10초 안에 끝나지 않으면 SIGKILL을 보냅니다. 한 번 실행의 최대 시간은 `MAKEBOARD_JOB_TIMEOUT`(기본 3600초)입니다.
- **운영 확인**: 운영(`environment = "prod"`) 서버에서는 실행 전에 한 번 더 확인합니다.

## 보안

- **에이전트 연결**: 에이전트는 서버별 토큰으로 인증합니다. 등록된 프로젝트 디렉터리, 올바른 타깃 이름, 허용된 문자의 인자만 실행합니다.
- **인자 값 제한**: 인자 값은 레시피 안에서 셸로 펼쳐지기 때문에 영문, 숫자, `_ . , : / @ + = % -`만 허용합니다. 서버와 에이전트가 모두 검사합니다.
- **편집 권한**: 웹에서 Makefile을 편집할 수 있다는 것은 그 서버에서 명령을 실행할 수 있다는 뜻입니다. 관리자 토큰은 실행 권한과 같다고 생각하세요.
- **최소 권한**: 서버 추가 화면의 "실행 계정"으로 root가 아닌 전용 계정을 지정하세요. docker 소켓을 쓸 수 있으면 사실상 root와 같다는 점에 유의하세요.
- **접근 제한**: 웹과 `/ws/agent`는 HTTPS 뒤, 가능하면 사내망이나 VPN 안에 두세요.

## 다음 단계로 고려할 것

- 사용자 계정과 서버별 권한, 운영 실행에 대한 다른 사람 승인 (현재는 관리자 토큰 1개)
- SSO(OIDC) 로그인
- Redis pub/sub로 서버 다중 워커
- 웹에서 저장한 Makefile을 git 커밋/PR로 남기기
- Alembic 마이그레이션 (현재는 시작할 때 테이블을 자동 생성)
