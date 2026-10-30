import logging
from collections.abc import AsyncIterator

from sqlalchemy import inspect, literal, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings

log = logging.getLogger("makeboard.db")
engine = create_async_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def init_db() -> None:
    from . import models  # noqa: F401  (테이블 등록)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # create_all 은 이미 있는 테이블에 나중에 추가한 칸을 만들지 않으므로 빠진 칸을 더한다
        await conn.run_sync(_add_missing_columns)
        # create_all 은 이미 있는 테이블에 나중에 추가한 인덱스를 만들지 않으므로 따로 확인해서 만든다
        await conn.run_sync(_create_missing_indexes)


def _add_missing_columns(conn) -> None:
    """모델에는 있는데 DB 테이블에는 없는 칸을 ALTER TABLE ... ADD COLUMN 으로 더한다.

    칸을 더하는 것만 한다 (이름 변경·삭제·타입 변경은 하지 않음). 기본값이 단순한 값(문자열·숫자·참거짓)이면
    DEFAULT 로 넣어 기존 행도 그 값을 갖게 하고, 그 밖에는 NULL 을 허용하는 칸으로 더한다.
    """
    insp = inspect(conn)
    q = conn.dialect.identifier_preparer.quote
    for table in Base.metadata.sorted_tables:
        if not insp.has_table(table.name):
            continue
        have = {c["name"] for c in insp.get_columns(table.name)}
        for col in table.columns:
            if col.name in have or col.primary_key:
                continue
            ddl = f"ALTER TABLE {q(table.name)} ADD COLUMN {q(col.name)} {col.type.compile(dialect=conn.dialect)}"
            default = col.default.arg if col.default is not None and col.default.is_scalar else None
            if isinstance(default, (bool, int, float, str)):
                value = literal(default, type_=col.type).compile(dialect=conn.dialect, compile_kwargs={"literal_binds": True})
                ddl += f" DEFAULT {value}"
            conn.execute(text(ddl))
            log.warning("DB 에 빠진 칸을 더했습니다: %s.%s", table.name, col.name)


def _create_missing_indexes(conn) -> None:
    for table in Base.metadata.sorted_tables:
        for index in table.indexes:
            index.create(conn, checkfirst=True)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
