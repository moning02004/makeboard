# 데모: kubectl 은 데모용 가짜(examples/demo/bin/kubectl)라 클러스터에 아무것도 하지 않습니다
NAMESPACE ?= api

.DEFAULT_GOAL := help
.PHONY: help apply restart pods top deploy

help: ## 사용 가능한 명령어 보기
	@awk 'BEGIN {FS = ":.*##"; printf "사용법: make \033[36m<명령어>\033[0m [변수=값]\n"} /^[a-zA-Z0-9_.-]+:.*?##/ { n = $$1; d = $$2; sub(/^ +/, "", d); w = 28 - length(n); if (w < 3) w = 3; s = ""; for (i = 0; i < w; i++) s = s "-"; printf "  \033[36m%s\033[0m \033[2m%s\033[0m %s\n", n, s, d } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

##@ 배포
apply: ## k8s/ 의 yaml 적용
	kubectl -n $(NAMESPACE) apply -f k8s/
restart: ## 디플로이먼트 다시 시작
	kubectl -n $(NAMESPACE) rollout restart deployment/api
deploy: ## 적용하고 다시 시작
	$(MAKE) apply
	$(MAKE) restart

##@ 확인
pods: ## 파드 상태
	kubectl -n $(NAMESPACE) get pods
top: ## 파드 CPU·메모리
	kubectl -n $(NAMESPACE) top pods
