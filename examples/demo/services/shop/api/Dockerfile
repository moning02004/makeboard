# 데모: shop api 를 빌드하는 Dockerfile. '구성'에서 api 왼쪽의 Dockerfile 노드를 눌러 고쳐 보세요
FROM python:3.12-slim AS base
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

FROM base
COPY . .
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
