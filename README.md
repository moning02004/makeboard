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

`http://<서버>:8000` 에 접속해 아이디 `admin`, 비밀번호 `MAKEBOARD_ADMIN_TOKEN` 값으로 로그인합니다. 이 관리자 계정은 사용자가 한 명도 없을 때 처음 한 번 만들어지며, 아이디와 비밀번호는 `MAKEBOARD_ADMIN_USER`, `MAKEBOARD_ADMIN_PASSWORD`로 바꿀 수 있습니다. 로그인한 뒤 **설정 → 내 계정**에서 비밀번호를 바꾸세요.

- **사용자와 권한**: 관리자가 **설정 → 사용자**에서 계정을 추가하고 권한을 고릅니다. 실행 기록에는 실행한 사람의 아이디가 남습니다.
  - **실행**: 서비스를 보고 명령을 실행합니다.
  - **편집**: 실행 + Makefile·yaml 수정.
  - **관리자**: 편집 + 서버 추가·편집·삭제, 사용자, 설정.
- **2단계 인증**: 편집과 관리자 권한은 2단계 인증(TOTP)이 필수입니다. 처음 로그인하면 QR 코드를 Google Authenticator·1Password 같은 인증 앱으로 찍어 등록하고, 이후 로그인할 때 6자리 코드를 함께 입력합니다. 등록할 때 받는 복구 코드 10개는 휴대폰을 잃어버렸을 때 한 번씩 쓸 수 있습니다. 실행 권한 사용자는 **설정 → 내 계정**에서 원하면 켤 수 있습니다.
  - 다른 사용자가 휴대폰을 잃어버렸으면 관리자가 **2단계 인증 초기화**를 누릅니다. 관리자 본인이 휴대폰과 복구 코드를 모두 잃었으면 서버에서 `create_admin ... --reset-otp`를 실행합니다.
- **CLI**: `Authorization: Bearer <MAKEBOARD_ADMIN_TOKEN>` 헤더로 API를 관리자 권한으로 부를 수 있습니다.
- **관리자 계정 만들기**: 명령어로도 만들 수 있습니다. 같은 아이디가 있으면 관리자로 바꾸고 비밀번호를 새로 정하므로, 비밀번호를 잊었을 때도 씁니다. `--password`를 빼면 입력을 받습니다.

  ```bash
  docker compose exec app python -m app.manage create_admin --username jeonghoon --name 유정훈
  ```

서버 상태를 [Beszel](https://beszel.dev)로 함께 본다면 웹 오른쪽 위의 **설정**에서 Beszel 주소를 넣으세요(`.env`의 `MAKEBOARD_BESZEL_URL`로도 됩니다). 서버 대시보드에 Beszel로 가는 버튼이 생깁니다. 주소의 `{name}`은 서버 이름으로 바뀝니다. 설정 창에서는 이 서버 주소(`MAKEBOARD_PUBLIC_URL`)도 바꿀 수 있고, 거기서 저장한 값이 `.env`보다 우선합니다.

운영에서는 앞단에 TLS 리버스 프록시를 두고 `MAKEBOARD_COOKIE_SECURE=true`로 설정하세요. 에이전트 연결(`/ws/agent`)도 같은 주소로 들어오므로 WebSocket 업그레이드를 허용해야 합니다.

- Caddy: 추가 설정이 필요 없습니다.
- nginx: `proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`를 추가합니다.
- 로그 스트림(SSE)이 끊기지 않도록 버퍼링을 끕니다. 서버가 `X-Accel-Buffering: no`를 보내므로 nginx는 자동으로 처리됩니다.

> 실행 상태를 메모리에서 관리하기 때문에 서버 프로세스(uvicorn 워커)는 **1개**로 운영합니다. 여러 개로 늘리려면 `server/app/hub.py`를 Redis pub/sub로 바꿔야 합니다.

## 2. 에이전트 설치 (관리할 서버마다)

에이전트는 Docker로만 설치합니다. 대상 서버에는 Docker만 있으면 됩니다.

1. 웹의 **+ 서버 추가**에서 서버 이름과 서비스 폴더(기본 `/home/ubuntu/services`)를 입력합니다. 쿠버네티스를 쓰는 서버면 **쿠버네티스 사용**을 켜고 kubeconfig 경로를 넣습니다.
2. 만들어진 명령어 한 줄을 대상 서버의 터미널에 붙여넣습니다.

```bash
docker build -t makeboard-agent http://<중앙서버>:8000/agent/docker.tar.gz && \
{ docker rm -f makeboard-agent; docker run -d --name makeboard-agent --restart unless-stopped --network host \
    --user ... --group-add ... -v /var/run/docker.sock:/var/run/docker.sock -v /home/ubuntu/services:/home/ubuntu/services \
    -e MAKEBOARD_SERVER=ws://<중앙서버>:8000/ws/agent -e MAKEBOARD_AGENT_ID=... -e MAKEBOARD_AGENT_TOKEN=... \
    -e MAKEBOARD_SCAN=/home/ubuntu/services makeboard-agent; }
```

중앙 서버가 빌드 컨텍스트(`/agent/docker.tar.gz`)를 내려주므로 레지스트리나 저장소 복사가 필요 없습니다. 같은 명령어를 다시 실행하면 최신 에이전트로 바뀝니다. 서비스 폴더나 쿠버네티스 설정을 바꾸거나 에이전트를 업데이트하려면 서버 목록의 **편집**에서 저장하고, 나온 명령어를 그 서버에서 실행하세요(이전 토큰은 무효가 됩니다).

- **서비스**: 서비스 폴더 바로 아래 폴더는 모두 서비스가 됩니다. Makefile이 없으면 웹에서 템플릿으로 만들 수 있고, 새 폴더를 만들면 30초 안에 나타납니다.
- **실행 환경**: 레시피는 컨테이너 안에서 실행됩니다. 이미지에는 `make`, `git`, `curl`, `ssh`, `docker`, `docker compose`, `kubectl`이 들어 있고, `docker` 명령은 마운트한 소켓으로 그 서버의 Docker를 씁니다. 다른 도구가 필요하면 `agent/Dockerfile`에 추가하세요.
- **쿠버네티스(k3s 등)**: 설치 화면에서 **쿠버네티스 사용**을 켜고 그 서버의 kubeconfig 경로(예: `/home/ubuntu/.kube/config`)를 넣으면 컨테이너에 읽기 전용으로 붙어 레시피의 `kubectl`이 그 클러스터를 씁니다. 서비스 폴더 소유자가 읽을 수 있는 파일이어야 합니다(k3s의 `/etc/rancher/k3s/k3s.yaml`은 기본이 root 전용). 서비스 폴더 이름과 같은 네임스페이스(또는 Makefile의 `NAMESPACE`/`NS` 변수)의 파드 상태와 CPU·메모리(`kubectl top`, metrics-server 필요)를 화면에 보여줍니다.
- **같은 경로 마운트**: 서비스 폴더는 호스트와 같은 경로로 마운트합니다. 그래야 `docker compose`의 상대 경로 볼륨이 호스트에서도 맞습니다.
- **실행 계정**: 레시피는 첫 서비스 폴더의 소유자 UID/GID(`--user`)로 실행되고, 만드는 파일도 그 계정 소유가 됩니다. docker 소켓의 그룹(`--group-add`)을 더합니다. docker 소켓을 쓸 수 있으면 사실상 호스트 root 권한이라는 점에 유의하세요.
- **호스트 네트워크**: `--network host`로 띄워서 호스트 이름과 리소스 값이 컨테이너가 아니라 그 서버 기준으로 잡힙니다.

### 제거

웹에서 서버의 휴지통 버튼을 누르면 서버와 서비스, 실행 기록이 지워지고 토큰이 무효가 됩니다. **서버 에이전트도 삭제**에 체크하면, 연결돼 있는 에이전트에게 자기 컨테이너를 지우라고 보내고 연결이 끊기는 것으로 결과를 확인합니다. 오프라인이거나 자동으로 지우지 못하면 직접 지울 명령어를 보여줍니다.

```bash
docker rm -f makeboard-agent && docker rmi makeboard-agent
```

서비스 폴더와 Makefile은 그대로 남습니다. `.env`의 `MAKEBOARD_AGENT_TOKENS`로 등록한 서버는 웹에서 지울 수 없습니다. `.env`에서 지우고 서버를 재시작하세요.

## 로컬 데모

Docker나 PostgreSQL 없이 서버·웹·에이전트와 예제 서비스 4개를 한 번에 띄워 둘러볼 수 있습니다. Python 3.11 이상이 필요하고, 웹을 처음 빌드할 때만 Node.js가 필요합니다.

```bash
./scripts/demo.sh              # http://127.0.0.1:8000
DEMO_PORT=8100 ./scripts/demo.sh
./scripts/demo.sh --reset      # 데모 DB와 예제 서비스를 처음 상태로
```

- 계정: 관리자 `admin` / `demo1234`, 실행 권한 `viewer` / `demo1234`. 데모에서는 2단계 인증이 선택입니다(`MAKEBOARD_OTP_REQUIRED=false`).
- 예제 서비스(`examples/demo/services`)는 `.demo/`에 복사해서 쓰므로 데모에서 고쳐도 저장소 파일은 바뀌지 않습니다. 모든 명령은 메시지만 출력합니다.
  - **shop**: 순차 배포(deploy)와 단계별 로그, `config.yaml` 편집·되돌리기, compose 구성도(`stack.yaml`)
  - **api**: 쿠버네티스 구성도(Ingress·Service·Deployment·ConfigMap·Secret·HPA)와 파드 상태·CPU·메모리. kubectl은 클러스터에 접속하지 않는 데모용 가짜(`examples/demo/bin/kubectl`)입니다
  - **batch**: 병렬 실행(check), 중지(slow), 실패(broken), 인자 입력(backfill)과 프리셋
  - **new-service**: Makefile이 없는 서비스 → 템플릿으로 만들기
- 로그는 `.demo/server.log`, `.demo/agent.log`에 남습니다. Ctrl+C로 끕니다.

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

웹에서 아이디 `admin`, 비밀번호 `dev-admin-token-please-change`로 로그인하면 `dev-local / demo`가 보입니다. 테스트는 `cd server && pytest`로 돌립니다.

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
- **편집 권한**: 웹에서 Makefile을 편집할 수 있다는 것은 그 서버에서 명령을 실행할 수 있다는 뜻입니다. 일반 사용자 계정도 실행 권한과 같다고 생각하고 꼭 필요한 사람에게만 만드세요.
- **설정 파일(yaml·Dockerfile) 보기·편집**: 서비스 화면의 **파일**에서 Makefile과 서비스 폴더(및 바로 아래 하위 폴더)의 `*.yaml`·`*.yml`·`Dockerfile`(`Dockerfile.*`, `*.Dockerfile`)을 봅니다. Dockerfile은 `FROM`이 있는지만 확인합니다(에이전트 0.6.0). 편집 권한이 있으면 고칠 수 있고, 저장 전에 yaml 문법을 검사합니다. 웹에서 고치면 처음 내용과 저장한 버전이 **변경 기록**에 남아(파일마다 최근 50개) 언제든 되돌릴 수 있습니다. 저장해도 바로 배포되지는 않으니 배포 명령어를 실행하세요. 에이전트 0.4.0 이상이 필요합니다.
- **구성도**: 서비스 화면 위쪽의 **명령어 | 구성**에서 **구성**을 고르면 서비스 폴더의 docker compose·쿠버네티스 yaml을 분석해 리소스와 연결을 흐름도로 보여줍니다.
  - 쿠버네티스: Ingress → Service → Deployment·StatefulSet·DaemonSet·Job·CronJob → ConfigMap·Secret·PVC, HPA → 대상. 파드 상태(준비 수)가 워크로드에 붙습니다.
  - compose: 서비스와 `depends_on`, 이름 있는 볼륨, `build:`의 Dockerfile(베이스 이미지·EXPOSE·CMD 표시, 패널에서 수정).
  - 노드를 누르면 오른쪽 패널에서 그 리소스의 yaml을 고치거나 삭제합니다(편집 권한). 파일 전체가 아니라 그 리소스 부분만 바뀌고, 변경 기록에 남습니다.
  - 파일에 없는데 다른 리소스가 가리키는 것(클러스터에 따로 만든 Secret 등)은 점선으로 보입니다.
  - 선: 실선은 켜지는 순서(먼저 → 나중)·요청 흐름, 점선은 설정·볼륨 사용. 카드는 끌어서 옮길 수 있고 위치가 저장됩니다(**자동 정렬**로 되돌리기).
  - **+ 노드 추가**: Redis, RabbitMQ, PostgreSQL, MySQL, MongoDB, Nginx 또는 직접 입력한 이미지를 넣습니다. 직접 입력은 **Dockerfile로 빌드**도 고를 수 있고, 빌드 폴더에 Dockerfile이 없으면 Python·Node.js·정적 웹 템플릿으로 만듭니다(compose만). compose 파일에는 서비스와 볼륨을 덧붙이고 고른 서비스에 `depends_on`을 더하며, 비밀번호는 `${이름_PASSWORD}`로 참조하고 값은 `.env`에 넣습니다(다시 인증). 쿠버네티스에는 Secret·Service·StatefulSet(또는 Deployment)을 새 파일로 만듭니다.
- **환경변수(.env)**: 서비스 화면의 **환경변수**에서 서비스 폴더의 `.env`, `.env.*`, `*.env`를 키 단위로 봅니다. 에이전트 0.5.0 이상이 필요합니다.
  - 목록에는 키 이름만 오고 값은 `••••••`로 가려집니다. 실행 권한 사용자는 키 이름만 봅니다.
  - 값 보기·수정·삭제는 편집자·관리자만, 그리고 **한 번 더 인증**(인증 앱 코드, 2단계 인증이 없으면 비밀번호)해야 합니다. 10분 동안 유지되고, 드러낸 값은 1분 뒤 다시 가려집니다.
  - 수정은 그 키의 줄만 바꾸고 주석·순서는 그대로 둡니다. 값은 Makeboard DB와 변경 기록에 남기지 않습니다.
  - 누가 언제 어떤 키를 보고 바꿨는지는 관리자의 **설정 → 기록**에 남습니다.
- **비밀값**: 쿠버네티스 `Secret`이 든 파일은 값을 `••••••`로 가리고 보기만 됩니다. `.env`처럼 yaml이 아닌 파일과 숨김 폴더, 서비스 폴더 밖 파일은 열 수 없습니다.
- **로그인 보호**: 비밀번호는 scrypt로 저장합니다. 같은 IP에서 10분 동안 5번 틀리면(비밀번호·인증 코드 모두) 잠시 로그인을 막습니다. 인증 코드는 한 번 쓰면 다시 쓸 수 없습니다.
- **최소 권한**: 서비스 폴더를 root가 아닌 전용 계정 소유로 두세요. 레시피가 그 계정으로 실행됩니다. docker 소켓을 쓸 수 있으면 사실상 root와 같다는 점에 유의하세요.
- **접근 제한**: 웹과 `/ws/agent`는 HTTPS 뒤, 가능하면 사내망이나 VPN 안에 두세요.

## 다음 단계로 고려할 것

- 서버별 권한, 운영 실행에 대한 다른 사람 승인
- SSO(OIDC) 로그인
- Redis pub/sub로 서버 다중 워커
- 웹에서 저장한 Makefile을 git 커밋/PR로 남기기
- Alembic 마이그레이션 (현재는 시작할 때 테이블을 자동 생성)
