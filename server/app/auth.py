"""로그인과 권한.

웹: 아이디/비밀번호로 로그인하면 서명한 세션 쿠키를 준다. 쿠키에는 사용자 번호와 session_ver 가 들어 있어서
비밀번호를 바꾸거나 계정을 지우면 그 사용자의 기존 세션이 모두 끊긴다.
CLI: Authorization: Bearer <MAKEBOARD_ADMIN_TOKEN> 은 관리자로 그대로 쓸 수 있다.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import secrets
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from urllib.parse import quote

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
    can_edit: bool = False
    otp_enabled: bool = False

    @property
    def editor(self) -> bool:
        return self.is_admin or self.can_edit

    @property
    def otp_required(self) -> bool:
        """관리자와 편집자는 2단계 인증이 필수다 (MAKEBOARD_OTP_REQUIRED=false 면 선택)."""
        return self.id is not None and self.editor and settings.otp_required

    @property
    def otp_setup_required(self) -> bool:
        return self.otp_required and not self.otp_enabled


def role_of(u: User) -> str:
    return "admin" if u.is_admin else "edit" if u.can_edit else "run"


# ------------------------------------------------------------------ 2단계 인증 (TOTP, RFC 6238)
# Google Authenticator·1Password 등 인증 앱과 같은 방식. 30초마다 바뀌는 6자리 코드
OTP_STEP, OTP_DIGITS, RECOVERY_COUNT = 30, 6, 10


def new_otp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _hotp(secret: str, counter: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    h = hmac.new(key, counter.to_bytes(8, "big"), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return f"{(int.from_bytes(h[o:o + 4], 'big') & 0x7FFFFFFF) % 10**OTP_DIGITS:0{OTP_DIGITS}d}"


def otp_now(secret: str, at: float | None = None) -> str:
    return _hotp(secret, int((at or time.time()) // OTP_STEP))


def check_otp(secret: str, code: str, last_step: int = 0) -> int | None:
    """맞으면 그 시간 칸(step)을, 틀리거나 이미 쓴 코드면 None. 시계가 조금 어긋나도 되도록 앞뒤 30초까지 본다."""
    code = re.sub(r"\s", "", code or "")
    if not secret or not re.fullmatch(rf"\d{{{OTP_DIGITS}}}", code):
        return None
    now = int(time.time() // OTP_STEP)
    for step in (now - 1, now, now + 1):
        if step > last_step and hmac.compare_digest(_hotp(secret, step), code):
            return step
    return None


def otp_uri(secret: str, username: str) -> str:
    return f"otpauth://totp/Makeboard:{quote(username)}?secret={secret}&issuer=Makeboard&digits={OTP_DIGITS}&period={OTP_STEP}"


def _code_hash(code: str) -> str:
    return hashlib.sha256(re.sub(r"[\s-]", "", code.lower()).encode()).hexdigest()


def new_recovery_codes(u: User) -> list[str]:
    """복구 코드 10개를 새로 만들어 해시만 저장하고, 원문은 한 번만 돌려준다."""
    codes = [f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(RECOVERY_COUNT)]
    u.recovery_codes = ",".join(_code_hash(c) for c in codes)
    return codes


def use_recovery_code(u: User, code: str) -> bool:
    hashes = [h for h in (u.recovery_codes or "").split(",") if h]
    h = _code_hash(code or "")
    if h not in hashes:
        return False
    hashes.remove(h)
    u.recovery_codes = ",".join(hashes)
    return True


def verify_second_factor(u: User, code: str) -> bool:
    """인증 앱 코드 또는 복구 코드. 맞으면 쓴 코드를 기록해 다시 못 쓰게 한다 (호출한 쪽에서 commit)."""
    step = check_otp(u.totp_secret, code, u.totp_last_step or 0)
    if step is not None:
        u.totp_last_step = step
        return True
    return use_recovery_code(u, code)


def recovery_left(u: User) -> int:
    return len([h for h in (u.recovery_codes or "").split(",") if h])


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


# 비밀번호는 맞고 2단계 코드를 기다리는 동안의 표. 5분 동안만 쓸 수 있다
def make_ticket(user: User) -> str:
    payload = f"otp.{user.id}.{user.session_ver}.{int(time.time()) + 300}"
    return f"{payload}.{_sign(payload)}"


def parse_ticket(value: str) -> tuple[int, int] | None:
    try:
        kind, uid, ver, exp, sig = value.split(".")
        if kind != "otp" or not hmac.compare_digest(sig, _sign(f"{kind}.{uid}.{ver}.{exp}")) or int(exp) < time.time():
            return None
        return int(uid), int(ver)
    except ValueError:
        return None


def check_token(token: str) -> bool:
    return secrets.compare_digest(token.encode(), settings.admin_token.encode())


async def current_user(request: Request, allow_setup: bool = False) -> CurrentUser:
    """로그인한 사용자. 2단계 인증을 아직 등록하지 않은 관리자·편집자는 등록 화면(allow_setup) 말고는 막는다."""
    cookie = request.cookies.get(COOKIE)
    parsed = parse_session(cookie) if cookie else None
    if parsed:
        async with SessionLocal() as s:
            u = await s.get(User, parsed[0])
        if u and u.session_ver == parsed[1]:
            cu = CurrentUser(u.id, u.username, bool(u.is_admin), u.name or "", bool(u.can_edit), bool(u.totp_secret))
            if cu.otp_setup_required and not allow_setup:
                raise HTTPException(status_code=403, detail="2단계 인증을 먼저 등록하세요")
            return cu
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer ") and check_token(header[7:].strip()):
        return CurrentUser(None, "admin-token", True)
    raise HTTPException(status_code=401, detail="로그인이 필요합니다")


async def require_user(request: Request) -> str:
    """로그인한 사용자 이름. 실행 기록의 '실행한 사람'으로도 쓴다."""
    return (await current_user(request)).username


async def require_editor(request: Request) -> str:
    """Makefile·yaml 을 고칠 수 있는 사용자 (편집자와 관리자)."""
    u = await current_user(request)
    if not u.editor:
        raise HTTPException(status_code=403, detail="편집 권한이 없습니다. 관리자에게 요청하세요")
    return u.username


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
async def create_admin(username: str, password: str, name: str = "", reset_otp: bool = False) -> bool:
    """관리자 계정을 만든다. 같은 아이디가 있으면 관리자로 바꾸고 비밀번호·이름을 새로 정한다(기존 로그인은 끊김).
    reset_otp 면 2단계 인증도 지워서, 다음 로그인 때 다시 등록하게 한다 (휴대폰과 복구 코드를 모두 잃었을 때).

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
            if reset_otp:
                u.totp_secret, u.totp_pending, u.recovery_codes = "", "", ""
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
