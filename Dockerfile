# 1) 웹 빌드
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 2) 서버 (빌드된 웹을 같은 프로세스에서 제공)
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app ./app
COPY --from=web /web/dist ./web
# 웹의 "서버 추가" 설치 스크립트가 내려주는 에이전트 파일
COPY agent/Dockerfile agent/makeboard_agent.py agent/requirements.txt ./agent/
ENV MAKEBOARD_WEB_DIST=/app/web MAKEBOARD_AGENT_DIR=/app/agent
RUN useradd --system --uid 10001 makeboard
USER makeboard
EXPOSE 8000
# 실행 상태를 메모리에서 관리하므로 워커는 1개로 둔다
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*"]
