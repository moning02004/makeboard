from datetime import datetime, timezone

from sqlalchemy import JSON, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    """SQLite는 시간대 정보를 버리므로 UTC로 간주해서 붙인다."""
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()


class Server(Base):
    """에이전트 하나 = 서버 하나."""

    __tablename__ = "servers"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # agent_id
    hostname: Mapped[str] = mapped_column(String(255), default="")
    environment: Mapped[str] = mapped_column(String(16), default="dev")
    version: Mapped[str] = mapped_column(String(32), default="")
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentKey(Base):
    """웹에서 추가한 에이전트의 토큰. 원문 대신 sha256 만 저장한다."""

    __tablename__ = "agent_keys"

    agent_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    token_sha: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Service(Base):
    """에이전트 설정에 등록된 프로젝트(Makefile이 있는 디렉터리)."""

    __tablename__ = "services"
    __table_args__ = (UniqueConstraint("server_id", "name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(128))
    path: Mapped[str] = mapped_column(String(1024), default="")
    makefile: Mapped[str] = mapped_column(Text, default="")
    makefile_sha: Mapped[str] = mapped_column(String(64), default="")
    sync_error: Mapped[str] = mapped_column(Text, default="")
    synced_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 캔버스 위치, 즐겨찾기 (여러 기기에서 같이 보이도록 서버에 저장)
    layout: Mapped[dict] = mapped_column(JSON, default=dict)


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    service_id: Mapped[int] = mapped_column(ForeignKey("services.id", ondelete="CASCADE"), index=True)
    target: Mapped[str] = mapped_column(String(128))
    vars: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="running")  # running | ok | failed | stopped
    multi: Mapped[int] = mapped_column(Integer, default=0)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    triggered_by: Mapped[str] = mapped_column(String(64), default="admin")
    commit: Mapped[str] = mapped_column(String(64), default="")  # 실행 당시 Makefile sha


class RunStep(Base):
    """실행 안에서 노드(타깃) 하나의 상태."""

    __tablename__ = "run_steps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    node: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued | running | ok | failed | stopped | skipped
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    cpu_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_rss_kb: Mapped[int | None] = mapped_column(Integer, nullable=True)


class RunLog(Base):
    __tablename__ = "run_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    ts: Mapped[float] = mapped_column(Float)  # epoch seconds
    node: Mapped[str] = mapped_column(String(128), default="")
    stream: Mapped[str] = mapped_column(String(8), default="out")  # out | meta | err
    line: Mapped[str] = mapped_column(Text, default="")
