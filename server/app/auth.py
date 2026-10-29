"""로그인과 권한.

웹: 아이디/비밀번호로 로그인하면 서명한 세션 쿠키를 준다. 쿠키에는 사용자 번호와 session_ver 가 들어 있어서
비밀번호를 바꾸거나 계정을 지우면 그 사용자의 기존 세션이 모두 끊긴다.
CLI: Authorization: Bearer <MAKEBOARD_ADMIN_TOKEN> 은 관리자로 그대로 쓸 수 있다.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass

from fastapi import HTTPException, Request
from sqlalchemy import func, select

from .config import settings
from .db import SessionLocal
from .models import User

log = logging.getLogger("makeboard.auth")
COOKIE = "mb_session"
SESSION_SECONDS = 60 * 60 * 24 * 14
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,32}$")
MIN_PASSWORD = 8


@dataclass
class CurrentUser:
    id: int | None  # 관리자 토큰(CLI)이면 None
    username: str
    is_admin: bool
    name: str = ""


# ------------------------------------------------------------------ 비밀번호 (scrypt, 표준 라이브러리)
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt$16384$8$1${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, digest = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(got.hex(), digest)


def check_password_rules(username: str | None, password: str) -> None:
    if username is not None and not USERNAME_RE.match(username):
        raise HTTPException(422, "아이디는 영문, 숫자, _ . - 로 2~32자입니다")
    if len(password) < MIN_PASSWORD:
        raise HTTPException(422, f"비밀번호는 {MIN_PASSWORD}자 이상이어야 합니다")


# ------------------------------------------------------------------ 세션 쿠키
def _sign(payload: str) -> str:
    secret = (settings.session_secret or settings.admin_token).encode()
    return hmac.new(secret, payload.encode(), hashlib.sha256).hexdigest()


def make_session(user: User) -> str:
    payload = f"{user.id}.{user.session_ver}.{int(time.time()) + SESSION_SECONDS}"
    return f"{payload}.{_sign(payload)}"


def parse_session(value: str) -> tuple[int, int] | None:
    try:
        uid, ver, exp, sig = value.split(".")
        if not hmac.compare_digest(sig, _sign(f"{uid}.{ver}.{exp}")) or int(exp) < time.time():
            return None
        return int(uid), int(ver)
    except ValueError:
        return None


def check_token(token: str) -> bool:
    return secrets.compare_digest(token.encode(), settings.admin_token.encode())


async def current_user(request: Request) -> CurrentUser:
    cookie = request.cookies.get(COOKIE)
    parsed = parse_session(cookie) if cookie else None
    if parsed:
        async with SessionLocal() as s:
            u = await s.get(User, parsed[0])
        if u and u.session_ver == parsed[1]:
            return CurrentUser(u.id, u.username, bool(u.is_admin), u.name or "")
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer ") and check_token(header[7:].strip()):
        return CurrentUser(None, "admin-token", True)
    raise HTTPException(status_code=401, detail="로그인이 필요합니다")


async def require_user(request: Request) -> str:
    """로그인한 사용자 이름. 실행 기록의 '실행한 사람'으로도 쓴다."""
    return (await current_user(request)).username


async def require_admin(request: Request) -> str:
    u = await current_user(request)
    if not u.is_admin:
        raise HTTPException(status_code=403, detail="관리자만 할 수 있습니다")
    return u.username


# ------------------------------------------------------------------ 로그인 시도 제한 (워커 1개, 메모리)
_fails: dict[str, deque] = defaultdict(deque)
FAIL_LIMIT, FAIL_WINDOW = 5, 600


def login_allowed(key: str) -> bool:
    q = _fails[key]
    while q and q[0] < time.time() - FAIL_WINDOW:
        q.popleft()
    return len(q) < FAIL_LIMIT


def login_failed(key: str) -> None:
    _fails[key].append(time.time())


def login_ok(key: str) -> None:
    _fails.pop(key, None)


# ------------------------------------------------------------------ 관리자 계정 만들기
async def create_admin(username: str, password: str, name: str = "") -> bool:
    """관리자 계정을 만든다. 같은 아이디가 있으면 관리자로 바꾸고 비밀번호·이름을 새로 정한다(기존 로그인은 끊김).

    만들었으면 True, 고쳤으면 False. python -m app.manage create_admin 이 쓴다.
    """
    check_password_rules(username, password)
    name = name.strip()[:64]
    async with SessionLocal() as s:
        u = (await s.execute(select(User).where(User.username == username))).scalar_one_or_none()
        if u:
            u.password_hash, u.is_admin, u.session_ver = hash_password(password), True, u.session_ver + 1
            if name:
                u.name = name
        else:
            s.add(User(username=username, name=name, password_hash=hash_password(password), is_admin=True))
        await s.commit()
    return u is None


# ------------------------------------------------------------------ 처음 시작할 때 관리자 만들기
async def ensure_admin() -> None:
    """사용자가 한 명도 없으면 관리자 계정을 만든다. 비밀번호는 MAKEBOARD_ADMIN_PASSWORD, 없으면 관리자 토큰."""
    async with SessionLocal() as s:
        if (await s.execute(select(func.count()).select_from(User))).scalar_one():
            return
        name = settings.admin_user or "admin"
        s.add(User(username=name, name="관리자", password_hash=hash_password(settings.admin_password or settings.admin_token), is_admin=True))
        await s.commit()
    log.warning("관리자 계정 '%s' 을 만들었습니다. 처음 비밀번호는 %s 입니다. 로그인한 뒤 설정에서 바꾸세요.",
                name, "MAKEBOARD_ADMIN_PASSWORD" if settings.admin_password else "MAKEBOARD_ADMIN_TOKEN")
