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
WORKDIR /opt/makeboard-agent
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY makeboard_agent.py .
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/opt/makeboard-agent/makeboard_agent.py"]
