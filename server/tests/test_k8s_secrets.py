import base64

import yaml

from app.k8s_secrets import keys_of, set_key, value_of

DOC = """\
# DB 비밀번호
apiVersion: v1
kind: Secret
metadata:
  name: api-db
type: Opaque
data:
  password: ZGVtbw==
  cert: |
    LS0tLS1CRUdJTg==
  url: cG9zdGdyZXM6Ly8=
"""


def b64(s: str) -> str:
    return base64.b64encode(s.encode()).decode()


def test_keys_and_values():
    obj = yaml.safe_load(DOC)
    assert [k["key"] for k in keys_of(obj)] == ["password", "cert", "url"]
    assert value_of(obj, "password") == ("demo", False)
    assert value_of(obj, "url") == ("postgres://", False)


def test_set_replace_add_delete_keep_rest():
    out = set_key(DOC, "password", "new pw")
    data = yaml.safe_load(out)["data"]
    assert data["password"] == b64("new pw") and data["url"] == "cG9zdGdyZXM6Ly8=" and "cert" in data
    assert out.startswith("# DB 비밀번호\n")
    # 블록 값(|)도 한 줄로 바꾼다
    out = set_key(out, "cert", "abc")
    assert yaml.safe_load(out)["data"]["cert"] == b64("abc") and "LS0tLS1CRUdJTg==" not in out
    # 새 키는 data 끝에, 지우기는 그 줄만
    out = set_key(out, "token", "t-1")
    assert yaml.safe_load(out)["data"]["token"] == b64("t-1")
    out = set_key(out, "url", None)
    assert "url" not in yaml.safe_load(out)["data"] and yaml.safe_load(out)["data"]["password"] == b64("new pw")


def test_string_data_and_missing_section():
    doc = "apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\nstringData:\n  password: 'a b'\n"
    out = set_key(doc, "password", 'say "hi"')
    assert yaml.safe_load(out)["stringData"]["password"] == 'say "hi"'
    out = set_key("apiVersion: v1\nkind: Secret\nmetadata:\n  name: y\n", "k", "v")
    assert yaml.safe_load(out)["data"] == {"k": b64("v")}
