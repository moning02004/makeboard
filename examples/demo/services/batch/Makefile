# 데모: 병렬 실행, 실패, 중지, 인자 입력을 시험해 보세요
SCRIPT ?=

.DEFAULT_GOAL := help
.PHONY: help test lint check slow broken backfill backfill-users

help: ## 사용 가능한 명령어 보기
	@awk 'BEGIN {FS = ":.*##"; printf "사용법: make \033[36m<명령어>\033[0m [변수=값]\n"} /^[a-zA-Z0-9_.-]+:.*?##/ { n = $$1; d = $$2; sub(/^ +/, "", d); w = 28 - length(n); if (w < 3) w = 3; s = ""; for (i = 0; i < w; i++) s = s "-"; printf "  \033[36m%s\033[0m \033[2m%s\033[0m %s\n", n, s, d } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ 품질
test: ## 테스트
	@for i in 1 2 3; do echo "test $$i passed"; sleep 0.5; done
lint: ## 린트
	@for i in 1 2 3; do echo "lint $$i ok"; sleep 0.4; done
check: ## 테스트와 린트를 동시에
	$(MAKE) -j test lint

##@ 작업
backfill: ## 백필 (SCRIPT=이름)
	@echo "running script $(SCRIPT)"; python3 -c "print('rows:', sum(range(1000000)))"
backfill-users: ## 사용자 백필 프리셋
	$(MAKE) backfill SCRIPT=backfill_users
slow: ## 30초 걸리는 작업 (중지 버튼 시험용)
	@echo start; sleep 30; echo done
broken: ## 항상 실패 (실패 표시 시험용)
	@echo "about to fail" >&2; exit 3
