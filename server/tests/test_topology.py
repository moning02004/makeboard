from app.topology import analyze, compose_blocks, delete_doc, replace_block, replace_doc

K8S = """\
# 앱 전체
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
  rules:
    - host: shop.example.com
      http:
        paths:
          - path: /api
            backend:
              service:
                name: api
                port:
                  number: 80
---
apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  selector:
    app: api
  ports:
    - port: 80
      targetPort: 8000
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: example/api:1.4
          envFrom:
            - configMapRef:
                name: api-config
          env:
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: api-db
                  key: password
---
apiVersion: v1
kind: Secret
metadata:
  name: api-db
data:
  password: ZGVtbw==
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: db
spec:
  serviceName: db
  template:
    metadata:
      labels:
        app: db
    spec:
      containers:
        - name: db
          image: postgres:16
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        resources:
          requests:
            storage: 10Gi
"""

COMPOSE = """\
services:
  web:
    image: nginx:1.27
    depends_on:
      - api
    ports:
      - "8080:80"

  # API 서버
  api:
    build: .
    depends_on: [db]
  db:
    image: postgres:16
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
"""


def edges(g):
    names = {n["id"]: f"{n['kind']}:{n['name']}" for n in g["nodes"]}
    return {(names[e["from"]], names[e["to"]]) for e in g["edges"]}


def test_k8s_graph():
    g = analyze({"k8s/app.yaml": K8S})
    assert edges(g) >= {
        ("Ingress:web", "Service:api"), ("Service:api", "Deployment:api"),
        ("Deployment:api", "ConfigMap:api-config"), ("Deployment:api", "Secret:api-db"),
        ("StatefulSet:db", "PersistentVolumeClaim:data"),
    }
    by = {f"{n['kind']}:{n['name']}": n for n in g["nodes"]}
    assert by["ConfigMap:api-config"]["missing"] is True  # 파일에 없는 ConfigMap
    assert by["Secret:api-db"]["editable"] is False and "ZGVtbw==" not in by["Secret:api-db"]["text"]
    assert ["replicas", "2"] in by["Deployment:api"]["summary"]
    assert [by[k]["rank"] for k in ("Ingress:web", "Service:api", "Deployment:api", "Secret:api-db")] == [0, 1, 2, 3]
    assert {e["kind"] for e in g["edges"] if e["label"] in ("80", "8000") or "shop.example.com" in e["label"]} == {"traffic"}
    assert {e["kind"] for e in g["edges"] if e["label"] in ("envFrom", "env", "template")} == {"ref"}


def test_compose_graph_and_blocks():
    g = analyze({"docker-compose.yml": COMPOSE})
    # 켜지는 순서대로: db → api → web, 볼륨은 쓰는 서비스로
    assert edges(g) == {("compose:api", "compose:web"), ("compose:db", "compose:api"), ("volume:pgdata", "compose:db")}
    assert {e["kind"] for e in g["edges"] if e["label"] == "먼저"} == {"start"}
    by = {n["name"]: n for n in g["nodes"]}
    assert [by[k]["rank"] for k in ("pgdata", "db", "api", "web")] == [0, 1, 2, 3]
    assert by["web"]["summary"] == [["image", "nginx:1.27"], ["ports", "8080:80"]] and by["api"]["summary"] == [["build", "."]]
    assert by["api"]["text"] == "api:\n  build: .\n  depends_on: [db]\n"  # 들여쓰기를 걷어서 보여 준다
    blocks, child = compose_blocks(COMPOSE)
    assert child == 2 and list(blocks) == ["web", "api", "db"]


def test_splice_keeps_rest_of_file():
    # 문서 하나만 바꾸고, 주석과 다른 문서는 그대로
    new = replace_doc(K8S, 1, "apiVersion: v1\nkind: Service\nmetadata:\n  name: api2\n")
    assert "name: api2" in new and "# 앱 전체" in new and new.count("\n---\n") == K8S.count("\n---\n")
    gone = delete_doc(K8S, 0)
    assert not gone.startswith("---") and "kind: Ingress" not in gone and gone.count("---") == K8S.count("---") - 1
    # compose: 서비스 블록만 바꾸고 지우기
    c2 = replace_block(COMPOSE, "api", "api:\n  build: ./api\n")
    assert "    build: ./api\n" in c2 and "# API 서버" in c2 and "volumes:\n  pgdata:" in c2
    c3 = replace_block(COMPOSE, "db", None)
    assert "postgres" not in c3 and "volumes:\n  pgdata:" in c3
