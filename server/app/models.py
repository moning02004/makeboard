from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint
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


class User(Base):
    """웹 로그인 계정. 관리자가 추가한다."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(64), default="")  # 화면에 보여줄 이름 (비우면 아이디)
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    # Makefile·yaml 을 고칠 수 있는지 (관리자는 항상 가능). 관리자와 편집자는 2단계 인증이 필수
    can_edit: Mapped[bool] = mapped_column(Boolean, default=False)
    # 2단계 인증(TOTP). totp_secret 이 있으면 켜진 것, totp_pending 은 QR 을 찍는 중인 비밀값
    totp_secret: Mapped[str] = mapped_column(String(64), default="")
    totp_pending: Mapped[str] = mapped_column(String(64), default="")
    totp_last_step: Mapped[int] = mapped_column(Integer, default=0)  # 같은 코드를 두 번 못 쓰게
    recovery_codes: Mapped[str] = mapped_column(Text, default="")  # 일회용 복구 코드의 sha256, 쉼표로 이음
    # 비밀번호를 바꾸면 올려서 그 사용자의 기존 로그인을 모두 끊는다
    session_ver: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AppSetting(Base):
    """웹에서 바꾼 설정. 없으면 .env 값을 쓴다 (prefs.py)."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


class AgentKey(Base):
    """웹에서 추가한 에이전트의 토큰. 원문 대신 sha256 만 저장한다."""

    __tablename__ = "agent_keys"

    agent_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    token_sha: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # 설치할 때 고른 값. 편집 화면에 채워 넣는다 (scan 은 ':' 로 이음)
    scan: Mapped[str] = mapped_column(Text, default="")
    kubeconfig: Mapped[str] = mapped_column(String(1024), default="")
    run_as: Mapped[str] = mapped_column(String(32), default="")


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
    # 서비스별 최근 실행 목록 (service_id = ? ORDER BY id DESC LIMIT n)
    __table_args__ = (Index("ix_runs_service_id_id", "service_id", "id"),)

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
    # 단계 상태를 바꿀 때마다 (run_id, node) 로 찾는다
    __table_args__ = (Index("ix_run_steps_run_id_node", "run_id", "node"),)

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
    # 로그는 실행별로 seq 순서대로 읽는다
    __table_args__ = (Index("ix_run_logs_run_id_seq", "run_id", "seq"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    ts: Mapped[float] = mapped_column(Float)  # epoch seconds
    node: Mapped[str] = mapped_column(String(128), default="")
    stream: Mapped[str] = mapped_column(String(8), default="out")  # out | meta | err
    line: Mapped[str] = mapped_column(Text, default="")


class FileRevision(Base):
    """웹에서 고친 설정 파일(yaml)의 버전. 처음 고칠 때 원래 내용도 남겨서 언제든 되돌릴 수 있다."""

    __tablename__ = "file_revisions"
    __table_args__ = (Index("ix_file_revisions_service_path", "service_id", "path", "id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    service_id: Mapped[int] = mapped_column(ForeignKey("services.id", ondelete="CASCADE"))
    path: Mapped[str] = mapped_column(String(512))
    content: Mapped[str] = mapped_column(Text, default="")
    sha: Mapped[str] = mapped_column(String(64), default="")
    author: Mapped[str] = mapped_column(String(64), default="")
    note: Mapped[str] = mapped_column(String(128), default="")  # 원래 내용 | 저장 | N번으로 되돌림
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
