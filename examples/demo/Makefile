NS ?= dev
SCRIPT ?=

.DEFAULT_GOAL := help
.PHONY: help pull migrate up deploy test lint check slow broken backfill backfill-rename-users backfill-remove-users clear-cache

help: ## 사용 가능한 명령어 보기
	@awk 'BEGIN {FS = ":.*##"; printf "사용법: make \033[36m<명령어>\033[0m [변수=값]\n"} /^[a-zA-Z0-9_.-]+:.*?##/ { n = $$1; d = $$2; sub(/^ +/, "", d); w = 28 - length(n); if (w < 3) w = 3; s = ""; for (i = 0; i < w; i++) s = s "-"; printf "  \033[36m%s\033[0m \033[2m%s\033[0m %s\n", n, s, d } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ 배포
pull: ## 이미지 받기
	@echo "pulling images for $(NS)"; sleep 1; echo " ✔ backend Pulled"
migrate: ## 마이그레이션
	@echo "Applying migrations"; sleep 1; echo "OK"
up: ## 기동
	@echo "starting"; echo "\033[32mStarted\033[0m"
deploy: ## 전체 배포
	$(MAKE) pull
	$(MAKE) migrate
	$(MAKE) up

##@ 품질
test: ## 테스트
	@for i in 1 2 3; do echo "test $$i"; sleep 0.5; done
lint: ## 린트
	@for i in 1 2 3; do echo "lint $$i"; sleep 0.4; done
check: ## 동시에
	$(MAKE) -j test lint
slow: ## 30초 걸리는 작업 (중지 버튼 시험용)
	@echo start; sleep 30; echo never
broken: ## 항상 실패 (실패 표시 시험용)
	@echo "about to fail" >&2; exit 3

##@ 백필
backfill: ## 백필 (SCRIPT=이름)
	@echo "running script $(SCRIPT)"; python3 -c "print(sum(range(1000000)))"
backfill-rename-users: ## 이름 변경
	$(MAKE) backfill SCRIPT=backfill_rename_users
backfill-remove-users: ## 사용자 제거
	$(MAKE) backfill SCRIPT=backfill_remove_not_allowed_users

##@ 데이터
clear-cache: ## 캐시 비우기
	@echo cleared
