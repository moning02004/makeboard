.DEFAULT_GOAL := help
.PHONY: help dev-server dev-web dev-agent test build up down logs

help: ## 사용 가능한 명령어 보기
	@awk 'BEGIN {FS = ":.*##"; printf "사용법: make \033[36m<명령어>\033[0m [변수=값]\n"} /^[a-zA-Z0-9_.-]+:.*?##/ { n = $$1; d = $$2; sub(/^ +/, "", d); w = 28 - length(n); if (w < 3) w = 3; s = ""; for (i = 0; i < w; i++) s = s "-"; printf "  \033[36m%s\033[0m \033[2m%s\033[0m %s\n", n, s, d } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ 개발
dev-server: ## 서버 실행 (SQLite, 자동 재시작)
	cd server && uvicorn app.main:app --reload --port 8000
dev-web: ## 웹 개발 서버 (http://localhost:5173)
	cd web && npm run dev
dev-agent: ## 로컬 에이전트 실행 (agent/agent.dev.toml)
	python3 agent/makeboard_agent.py -c agent/agent.dev.toml -v
test: ## 서버 테스트
	cd server && python -m pytest -q

##@ 배포
build: ## 도커 이미지 빌드
	docker compose build
up: ## 실행
	docker compose up -d
down: ## 중지
	docker compose down
logs: ## 서버 로그
	docker compose logs -f app
