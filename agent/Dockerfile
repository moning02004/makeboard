# Makeboard 에이전트 이미지.
# 호스트에 아무것도 설치하지 않고 컨테이너로 실행한다. 레시피의 docker / docker compose 는
# 마운트한 /var/run/docker.sock 으로 호스트의 Docker 를 쓴다.
FROM docker:27.3.1-cli AS docker

FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends make git curl ca-certificates openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/
# 레시피의 kubectl 과 쿠버네티스 서비스 상태 확인용. 클러스터 접속은 설치할 때 붙이는 kubeconfig 로 한다.
# 기본은 빌드할 때의 최신 안정 버전. 고정하려면 --build-arg KUBECTL_VERSION=v1.31.4
ARG KUBECTL_VERSION=stable
RUN v="$KUBECTL_VERSION"; [ "$v" = stable ] && v="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"; \
    curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/$v/bin/linux/$(dpkg --print-architecture)/kubectl" \
 && chmod +x /usr/local/bin/kubectl
WORKDIR /opt/makeboard-agent
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY makeboard_agent.py .
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/opt/makeboard-agent/makeboard_agent.py"]
