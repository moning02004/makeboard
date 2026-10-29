"""Makefile 이 없는 서비스에 처음 만들어 줄 템플릿.

저장할 때는 parse_makefile → to_makefile 을 거치므로 help 타깃과 .DEFAULT_GOAL 이 자동으로 붙는다.
"""

TEMPLATES: list[dict[str, str]] = [
    {
        "id": "compose",
        "name": "Docker Compose",
        "description": "docker compose 로 띄우는 서비스. 시작, 중지, 로그, 배포 명령어",
        "content": """##@ 실행
up: ## 컨테이너 시작
\tdocker compose up -d
down: ## 컨테이너 중지
\tdocker compose down
restart: ## 다시 시작
\tdocker compose restart

##@ 확인
ps: ## 상태 보기
\tdocker compose ps
logs: ## 최근 로그 200줄
\tdocker compose logs --tail=200

##@ 배포
pull: ## 최신 이미지 받기
\tdocker compose pull
build: ## 이미지 빌드
\tdocker compose build
deploy: ## 최신 이미지로 다시 띄우기
\t$(MAKE) pull
\t$(MAKE) up
""",
    },
    {
        "id": "k8s",
        "name": "Kubernetes",
        "description": "kubectl 로 이 폴더의 yaml 을 적용. 네임스페이스는 폴더 이름",
        "content": """# 네임스페이스. 비우면 폴더 이름을 쓰고, Makeboard 도 이 네임스페이스의 파드 상태를 보여 준다
NAMESPACE ?= $(notdir $(CURDIR))
APP ?=

##@ 배포
ns: ## 네임스페이스 만들기 (이미 있으면 그대로)
\tkubectl create namespace $(NAMESPACE) --dry-run=client -o yaml | kubectl apply -f -
apply: ## 이 폴더의 yaml 적용
\tkubectl -n $(NAMESPACE) apply -f .
restart: ## 디플로이먼트 다시 시작 (APP=이름)
\tkubectl -n $(NAMESPACE) rollout restart deployment/$(APP)
delete: ## 이 폴더의 리소스 삭제
\tkubectl -n $(NAMESPACE) delete -f .
deploy: ## 네임스페이스를 만들고 적용
\t$(MAKE) ns
\t$(MAKE) apply

##@ 확인
pods: ## 파드 상태
\tkubectl -n $(NAMESPACE) get pods -o wide
top: ## 파드 CPU·메모리
\tkubectl -n $(NAMESPACE) top pods
logs: ## 최근 로그 200줄 (APP=이름)
\tkubectl -n $(NAMESPACE) logs deployment/$(APP) --tail=200
""",
    },
    {
        "id": "docker",
        "name": "Docker",
        "description": "compose 없이 docker run 으로 띄우는 컨테이너 하나 (Dockerfile 빌드 포함)",
        "content": """NAME ?= $(notdir $(CURDIR))
# 레지스트리 이미지를 쓰면 바꾸세요 (예: nginx:1.27). Dockerfile 로 빌드하면 이 이름으로 태그합니다
IMAGE ?= $(NAME):local
PORT ?= 8080:80

##@ 실행
run: ## 컨테이너 만들고 시작
\tdocker run -d --name $(NAME) --restart unless-stopped -p $(PORT) $(IMAGE)
stop: ## 중지
\tdocker stop $(NAME)
start: ## 다시 시작
\tdocker start $(NAME)
rm: ## 컨테이너 삭제
\tdocker rm -f $(NAME)

##@ 확인
ps: ## 상태 보기
\tdocker ps -a --filter name=$(NAME)
logs: ## 최근 로그 200줄
\tdocker logs --tail=200 $(NAME)

##@ 배포
build: ## Dockerfile 로 이미지 빌드
\tdocker build -t $(IMAGE) .
pull: ## 레지스트리에서 이미지 받기
\tdocker pull $(IMAGE)
deploy: ## 빌드하고 컨테이너 다시 만들기
\t$(MAKE) build
\t$(MAKE) rm
\t$(MAKE) run
""",
    },
    {
        "id": "basic",
        "name": "기본",
        "description": "예시 명령어 하나. 웹에서 노드를 추가해 채워 나갑니다",
        "content": """##@ 기본
hello: ## 예시 명령어 (편집해서 쓰세요)
\t@echo "hello" && pwd
""",
    },
    {
        "id": "empty",
        "name": "빈 파일",
        "description": "help 만 있는 빈 Makefile",
        "content": "",
    },
]

BY_ID = {t["id"]: t for t in TEMPLATES}
