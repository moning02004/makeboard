import os

os.environ.setdefault("MAKEBOARD_ADMIN_TOKEN", "test-token-test-token")

import pytest  # noqa: E402

from app.makefile import ModelError, collect, parse_makefile, to_makefile, validate_model  # noqa: E402

SAMPLE = """\
COMPOSE := docker compose -f docker-compose.yaml
NS ?= prod
SCRIPT ?=

# 배포 관련
##@ 배포
pull: ## 최신 이미지 받기
\t$(COMPOSE) pull backend worker
migrate: ## DB 마이그레이션
\t$(COMPOSE) run --rm backend python3 manage.py migrate
up: ## 컨테이너 기동
\t$(COMPOSE) up -d backend worker
deploy: ## 전체 배포
\t$(MAKE) pull
\t$(MAKE) migrate
\t$(MAKE) up

##@ 품질
test: ## 테스트
\tpytest -q
lint: ## 린트
\truff check .
check: ## 동시에
\t$(MAKE) -j test lint

##@ 백필
backfill: ## 백필 (SCRIPT=이름)
\t$(COMPOSE) run --rm backend python3 manage.py runscript $(SCRIPT)
# 사용자 이름 정리
backfill-rename-users: ## 사용자 이름 형식 변경
\t$(MAKE) backfill SCRIPT=backfill_rename_users

%.txt: %.md
\tcp $< $@
"""


def test_kinds_and_groups():
    m = parse_makefile(SAMPLE)
    n = m["nodes"]
    assert m["order"][0] == "help" and n["help"]["kind"] == "help"
    assert n["pull"]["kind"] == "cmd" and n["pull"]["group"] == "배포"
    assert n["deploy"] == {**n["deploy"], "kind": "comp", "mode": "seq", "steps": ["pull", "migrate", "up"]}
    assert n["check"]["mode"] == "par" and n["check"]["steps"] == ["test", "lint"]
    assert n["backfill-rename-users"]["kind"] == "preset"
    assert n["backfill-rename-users"]["args"] == {"SCRIPT": "backfill_rename_users"}
    assert n["backfill-rename-users"]["comments"] == ["# 사용자 이름 정리"]
    assert [v["name"] for v in m["vars"]] == ["COMPOSE", "NS", "SCRIPT"]
    assert m["extra"] == ["%.txt: %.md", "\tcp $< $@"]
    assert m["readonly"] is None


def test_roundtrip_is_stable():
    m1 = parse_makefile(SAMPLE)
    text = to_makefile(m1)
    m2 = parse_makefile(text)
    assert m2["order"] == m1["order"]
    assert m1["nodes"]["help"].get("virtual") and not m2["nodes"]["help"].get("virtual")
    strip = lambda ns: {k: v for k, v in ns.items() if k != "help"}
    assert strip(m2["nodes"]) == strip(m1["nodes"])
    assert to_makefile(m2) == text
    assert ".DEFAULT_GOAL := help" in text and "##@ 백필" in text


def test_collect_order():
    m = parse_makefile(SAMPLE)
    assert collect(m, "deploy") == ["deploy", "pull", "migrate", "up"]
    assert collect(m, "backfill-rename-users") == ["backfill-rename-users", "backfill"]


def test_readonly_with_conditionals():
    m = parse_makefile("ifeq ($(ENV),prod)\nNS := prod\nendif\nup:\n\techo up\n")
    assert m["readonly"]


def test_validate_rejects_cycles_and_newlines():
    m = parse_makefile(SAMPLE)
    m["nodes"]["pull"] = {"name": "pull", "kind": "comp", "mode": "seq", "steps": ["deploy"]}
    with pytest.raises(ModelError):
        validate_model(m)
    m = parse_makefile(SAMPLE)
    m["nodes"]["up"]["cmds"] = ["echo a\nrm -rf /"]
    with pytest.raises(ModelError):
        validate_model(m)
    m = parse_makefile(SAMPLE)
    m["nodes"]["backfill-rename-users"]["args"] = {"SCRIPT": "x; rm -rf /"}
    with pytest.raises(ModelError):
        validate_model(m)


def test_validate_accepts_parsed_model():
    m = parse_makefile(SAMPLE)
    clean = validate_model(m)
    clean["extra"] = m["extra"]
    again = parse_makefile(to_makefile(clean))["nodes"]
    assert {k: v for k, v in again.items() if k != "help"} == {k: v for k, v in m["nodes"].items() if k != "help"}


def test_help_text_format():
    from app.makefile import help_text
    lines = help_text(parse_makefile(SAMPLE))
    assert lines[0].startswith("사용법")
    assert "  pull ------------------------ 최신 이미지 받기" in lines
    assert "백필" in lines
