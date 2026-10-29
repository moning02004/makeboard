import hashlib
import hmac
import secrets

from fastapi import HTTPException, Request

from .config import settings

COOKIE = "mb_session"


def session_value() -> str:
    secret = (settings.session_secret or settings.admin_token).encode()
    return hmac.new(secret, b"makeboard-admin", hashlib.sha256).hexdigest()


def check_token(token: str) -> bool:
    return secrets.compare_digest(token.encode(), settings.admin_token.encode())


async def require_admin(request: Request) -> str:
    """세션 쿠키(웹) 또는 Authorization: Bearer <admin_token>(CLI) 를 확인한다."""
    cookie = request.cookies.get(COOKIE)
    if cookie and secrets.compare_digest(cookie, session_value()):
        return "admin"
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer ") and check_token(header[7:].strip()):
        return "admin"
    raise HTTPException(status_code=401, detail="로그인이 필요합니다")
