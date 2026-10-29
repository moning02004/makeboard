# 데모: 실제로는 아무것도 바꾸지 않고 메시지만 출력합니다
TAG ?= latest

.DEFAULT_GOAL := help
.PHONY: help pull migrate up deploy logs status

help: ## 사용 가능한 명령어 보기
	@awk 'BEGIN {FS = ":.*##"; printf "사용법: make \033[36m<명령어>\033[0m [변수=값]\n"} /^[a-zA-Z0-9_.-]+:.*?##/ { n = $$1; d = $$2; sub(/^ +/, "", d); w = 28 - length(n); if (w < 3) w = 3; s = ""; for (i = 0; i < w; i++) s = s "-"; printf "  \033[36m%s\033[0m \033[2m%s\033[0m %s\n", n, s, d } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ 배포
pull: ## 이미지 받기 (TAG=버전)
	@echo "pulling shop:$(TAG)"; sleep 1; echo " ✔ web Pulled"; sleep 0.5; echo " ✔ worker Pulled"
migrate: ## DB 마이그레이션
	@echo "Applying migrations"; for i in 1 2 3; do sleep 0.4; echo "  0$${i}_auto ... OK"; done
up: ## 컨테이너 기동
	@echo "starting web, worker"; sleep 0.5; echo "\033[32mStarted\033[0m"
deploy: ## 전체 배포 (받기 → 마이그레이션 → 기동)
	$(MAKE) pull
	$(MAKE) migrate
	$(MAKE) up

##@ 확인
status: ## 상태 보기
	@echo "web     running  0.0.0.0:8080->80/tcp"; echo "worker  running"
logs: ## 최근 로그
	@for i in 1 2 3 4 5; do echo "$$(date +%T) GET /api/items 200 $$((RANDOM % 90 + 10))ms"; sleep 0.3; done
