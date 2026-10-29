import yaml

from app.catalog import BY_ID, add_compose_service, add_depends_on, compose_body, k8s_manifest
from app.topology import analyze

COMPOSE = """\
# 앱
services:
  web:
    image: nginx:1.27
    depends_on: [api]

  api:
    image: example/api:1
    depends_on:
      - db
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
"""


def test_add_redis_to_compose_keeps_file_and_links():
    body, vol = compose_body(BY_ID["redis"], "cache", "redis:7", 6379, True)
    out = add_compose_service(COMPOSE, "cache", body, vol)
    out = add_depends_on(out, "api", "cache")
    out = add_depends_on(out, "web", "cache")
    data = yaml.safe_load(out)
    assert data["services"]["cache"]["command"] == ["redis-server", "--requirepass", "${CACHE_PASSWORD}"]
    assert data["services"]["cache"]["volumes"] == ["cache-data:/data"]
    assert set(data["volumes"]) == {"pgdata", "cache-data"}
    assert data["services"]["api"]["depends_on"] == ["db", "cache"]
    assert data["services"]["web"]["depends_on"] == ["api", "cache"]
    assert out.startswith("# 앱\n")  # 주석은 그대로
    names = {n["name"] for n in analyze({"docker-compose.yml": out})["nodes"]}
    assert {"cache", "cache-data"} <= names


def test_add_to_empty_compose_and_no_password_item():
    body, vol = compose_body(BY_ID["nginx"], "proxy", "nginx:1.27", 80, False)
    out = add_compose_service("", "proxy", body, vol)
    assert yaml.safe_load(out) == {"services": {"proxy": {"image": "nginx:1.27", "restart": "unless-stopped", "ports": ["80:80"]}}}


def test_k8s_manifest_graph():
    text = k8s_manifest(BY_ID["rabbitmq"], "mq", "rabbitmq:3-management", 5672, "pw-123")
    g = analyze({"k8s/mq.yaml": text})
    kinds = {f"{n['kind']}:{n['name']}" for n in g["nodes"]}
    assert {"Secret:mq-secret", "Service:mq", "StatefulSet:mq", "PersistentVolumeClaim:data"} <= kinds
    edges = {(e["from"].split("|")[-1], e["kind"]) for e in g["edges"]}
    assert len(g["edges"]) >= 3 and ("pw-123" not in str(g["nodes"]))  # Secret 값은 가려진다


def test_custom_service_with_build():
    body, vol = compose_body(BY_ID["custom"], "worker", "", 8000, False, "./worker")
    assert yaml.safe_load(body) == {"build": "./worker", "restart": "unless-stopped", "ports": ["8000:8000"]}
    out = add_compose_service("services:\n  web:\n    image: nginx\n", "worker", body, vol)
    g = analyze({"docker-compose.yml": out})
    assert any(n["kind"] == "Dockerfile" and n["name"] == "worker/Dockerfile" for n in g["nodes"])
