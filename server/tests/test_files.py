import os
import sys
from pathlib import Path

import pytest

from app.files import has_secret, mask_secrets, yaml_error

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))
import makeboard_agent  # noqa: E402

MANIFEST = """\
apiVersion: v1
kind: Secret
metadata:
  name: db
type: Opaque
data:
  password: cGFzc3dvcmQ=
  url: |
    cG9zdGdyZXM6Ly8=
stringData:
  token: abc123
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
data:
  LOG_LEVEL: debug
"""


def test_mask_only_secret_documents():
    out = mask_secrets(MANIFEST)
    assert has_secret(MANIFEST)
    assert "cGFzc3dvcmQ=" not in out and "cG9zdGdyZXM6Ly8=" not in out and "abc123" not in out
    assert "  password: ••••••" in out and "  token: ••••••" in out
    assert "name: db" in out and "LOG_LEVEL: debug" in out  # 키 이름과 Secret 이 아닌 문서는 그대로
    assert out.count("\n") == MANIFEST.count("\n")


def test_yaml_error_points_to_line():
    assert yaml_error(MANIFEST) is None
    err = yaml_error("a: 1\nb: [1, 2\nc: 3\n")
    assert err and "yaml 문법 오류" in err and "번째 줄" in err


def test_agent_rejects_paths_outside_service(tmp_path):
    svc = tmp_path / "svc"
    (svc / "k8s").mkdir(parents=True)
    (svc / "k8s" / "deploy.yaml").write_text("a: 1\n")
    (tmp_path / "outside.yaml").write_text("secret: 1\n")
    os.symlink(tmp_path / "outside.yaml", svc / "link.yaml")
    agent = makeboard_agent.Agent.__new__(makeboard_agent.Agent)
    agent.cfg = type("C", (), {"projects": {"svc": svc}})()
    assert agent._project_file("svc", "k8s/deploy.yaml")[1].name == "deploy.yaml"
    for bad in ("../outside.yaml", "/etc/passwd.yaml", "link.yaml", "Makefile", ".env.yaml", "a/b/c.yaml", ".git/x.yaml"):
        with pytest.raises(ValueError):
            agent._project_file("svc", bad)
