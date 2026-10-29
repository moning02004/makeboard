"""웹의 설정 창에서 바꿀 수 있는 값.

DB 에 저장한 값이 있으면 그것을 쓰고, 없으면 .env(MAKEBOARD_*) 값을 쓴다.
워커 1개를 전제로 메모리에 들고 있다가 저장할 때 같이 바꾼다.
"""

from __future__ import annotations

import re

from sqlalchemy import delete, select

from .config import settings
from .db import SessionLocal
from .models import AppSetting

URL_RE = re.compile(r"^https?://[^\s]{1,500}$")
# 키: 화면에 보여줄 설명
EDITABLE: dict[str, str] = {
    "beszel_url": "{name} 은 서버 이름으로 바뀝니다",
    "public_url": "에이전트가 접속할 주소",
}
_saved: dict[str, str] = {}


async def load() -> None:
    async with SessionLocal() as s:
        rows = (await s.execute(select(AppSetting).where(AppSetting.key.in_(EDITABLE)))).scalars().all()
    _saved.clear()
    _saved.update({r.key: r.value for r in rows})


def env_value(key: str) -> str:
    return str(getattr(settings, key) or "")


def get(key: str) -> str:
    return _saved[key] if key in _saved else env_value(key)


def describe() -> dict[str, dict]:
    return {k: {"value": get(k), "env": env_value(k), "saved": k in _saved, "help": EDITABLE[k]} for k in EDITABLE}


def clean(key: str, value: str) -> str:
    """빈 값은 '끄기'로 저장한다. 그 밖에는 http(s) 주소만 받는다."""
    if key not in EDITABLE:
        raise ValueError(f"바꿀 수 없는 설정입니다: {key}")
    value = value.strip()
    if value and not URL_RE.match(value):
        raise ValueError("http:// 또는 https:// 로 시작하는 주소를 입력하세요")
    return value.rstrip("/") if key == "public_url" else value


async def save(changes: dict[str, str | None]) -> None:
    """값이 None 이면 저장한 값을 지우고 .env 값으로 돌아간다."""
    cleaned = {k: (None if v is None else clean(k, v)) for k, v in changes.items()}
    async with SessionLocal() as s:
        for k, v in cleaned.items():
            await s.execute(delete(AppSetting).where(AppSetting.key == k))
            if v is not None:
                s.add(AppSetting(key=k, value=v))
        await s.commit()
    for k, v in cleaned.items():
        if v is None:
            _saved.pop(k, None)
        else:
            _saved[k] = v
