"""관리 명령어.

    python -m app.manage create_admin --username <아이디> --name <이름> [--password <비밀번호>]

docker compose 로 띄웠다면:

    docker compose exec app python -m app.manage create_admin --username jeonghoon --name 유정훈

--password 를 빼면 화면에서 두 번 묻는다(셸 기록에 남지 않게). 같은 아이디가 있으면 관리자로 바꾸고
비밀번호와 이름을 새로 정한다. 비밀번호를 잊었을 때 되살리는 데도 쓴다.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys

from fastapi import HTTPException


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m app.manage", description="Makeboard 관리 명령어")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create_admin", help="관리자 계정 만들기 (있으면 관리자로 바꾸고 비밀번호 재설정)")
    c.add_argument("--username", "-u", required=True, help="로그인 아이디 (영문, 숫자, _ . - 2~32자)")
    c.add_argument("--name", "-n", default="", help="화면에 보여줄 이름")
    c.add_argument("--password", "-p", help="비밀번호 (8자 이상). 빼면 입력받는다")
    args = ap.parse_args(argv)

    password = args.password
    if password is None:
        password = getpass.getpass("비밀번호: ")
        if password != getpass.getpass("비밀번호 확인: "):
            print("비밀번호가 서로 다릅니다", file=sys.stderr)
            return 1

    # 설정(.env)을 읽으므로 인자를 확인한 뒤에 불러온다
    from .auth import create_admin
    from .db import engine, init_db

    async def run() -> bool:
        try:
            await init_db()
            return await create_admin(args.username.strip(), password, args.name)
        finally:
            await engine.dispose()

    try:
        created = asyncio.run(run())
    except HTTPException as e:
        print(e.detail, file=sys.stderr)
        return 1
    print(f"관리자 '{args.username.strip()}' 을 {'만들었습니다' if created else '관리자로 바꾸고 비밀번호를 새로 정했습니다'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
