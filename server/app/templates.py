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
