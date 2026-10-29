from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from .config import settings

engine = create_async_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def init_db() -> None:
    from . import models  # noqa: F401  (테이블 등록)

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # create_all 은 이미 있는 테이블에 나중에 추가한 인덱스를 만들지 않으므로 따로 확인해서 만든다
        await conn.run_sync(_create_missing_indexes)


def _create_missing_indexes(conn) -> None:
    for table in Base.metadata.sorted_tables:
        for index in table.indexes:
            index.create(conn, checkfirst=True)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
