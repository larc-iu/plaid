"""dig4el's own database: everything that is not the linguistic record.

The linguistic record (translations, words, concept links, fields) lives in Plaid.
This SQLite file holds the language registry, inference runs with their approvals
and overrides, the registry of Plaid documents each language depends on, and the
background job queue.

Schema changes are numbered in ``MIGRATIONS`` and applied by ``engine()`` using
SQLite's ``user_version``; a fresh database is created at the current schema.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker

from .config import settings


def now() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


class Language(Base):
    """One language under study: a Plaid project plus the identity dig4el needs for
    typological lookups."""

    __tablename__ = "languages"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String, nullable=False)
    glottocode: Mapped[str] = mapped_column(String, nullable=False, default="")
    wals_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    grambank_name: Mapped[str] = mapped_column(String, nullable=False, default="")
    pivot_language: Mapped[str] = mapped_column(String, nullable=False, default="English")
    delimiters: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    plaid_project_id: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    layers: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    open_to_members: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    documents: Mapped[list["QuestionnaireDocument"]] = relationship(back_populates="language",
                                                                    cascade="all, delete-orphan")
    runs: Mapped[list["InferenceRun"]] = relationship(back_populates="language",
                                                      cascade="all, delete-orphan",
                                                      order_by="InferenceRun.created_at.desc()")

    @property
    def typology_name(self) -> str:
        """The name used to look the language up in WALS and Grambank."""
        return self.wals_name or self.grambank_name or self.name


class QuestionnaireDocument(Base):
    """A Plaid document holding one questionnaire's translations for a language."""

    __tablename__ = "questionnaire_documents"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    language_id: Mapped[str] = mapped_column(ForeignKey("languages.id"), nullable=False)
    questionnaire_uid: Mapped[str] = mapped_column(String, nullable=False)
    plaid_document_id: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    language: Mapped[Language] = relationship(back_populates="documents")


class Job(Base):
    """A unit of background work (an inference run, later an LLM stage), executed by
    the worker in ``jobs.py``. The user's Plaid token rides along so the job acts as
    the person who started it, and is erased when the job finishes."""

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    payload: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String, nullable=False, default="queued")  # queued/running/done/failed
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    token: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class InferenceRun(Base):
    """One run of the pipeline over a language's published translations, with the
    caretaker's review: overrides and approval. The approved run is what dig4el's
    ``cq_knowledge.json`` used to be. Progress and failure live on the run's job."""

    __tablename__ = "inference_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    language_id: Mapped[str] = mapped_column(ForeignKey("languages.id"), nullable=False)
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    inputs: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)  # documents + versions used
    settings_json: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    report: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    overrides: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)  # parameter -> {code, by, at}
    approved_by: Mapped[str] = mapped_column(String, nullable=False, default="")
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    language: Mapped[Language] = relationship(back_populates="runs")
    job: Mapped[Job | None] = relationship(lazy="joined")

    @property
    def status(self) -> str:
        return self.job.status if self.job else "done"

    @property
    def error(self) -> str:
        return self.job.error if self.job else ""

    @property
    def approved(self) -> bool:
        return bool(self.approved_by)


# Numbered schema changes for databases created at an earlier schema. A fresh
# database gets the current schema from ``create_all`` and skips them.
MIGRATIONS: list[list[str]] = [
    [  # 1: runs carry their job; the unused document columns go
        "ALTER TABLE inference_runs ADD COLUMN job_id VARCHAR REFERENCES jobs(id)",
        "DELETE FROM inference_runs WHERE status IN ('queued', 'running', 'failed')",
        "ALTER TABLE inference_runs DROP COLUMN status",
        "ALTER TABLE inference_runs DROP COLUMN error",
        "ALTER TABLE questionnaire_documents DROP COLUMN version_seen",
        "ALTER TABLE questionnaire_documents DROP COLUMN missing",
    ],
]


_engine = None
_Session: sessionmaker | None = None


def engine():
    global _engine, _Session
    if _engine is None:
        _engine = create_engine(f"sqlite:///{settings().db_path}", future=True,
                                connect_args={"check_same_thread": False})
        with _engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA journal_mode=WAL")
            fresh = not conn.exec_driver_sql(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='languages'").fetchone()
        Base.metadata.create_all(_engine)
        with _engine.begin() as conn:
            version = conn.exec_driver_sql("PRAGMA user_version").scalar() or 0
            if fresh:
                version = len(MIGRATIONS)
            for n, statements in enumerate(MIGRATIONS[version:], start=version + 1):
                for sql in statements:
                    conn.exec_driver_sql(sql)
                version = n
            conn.exec_driver_sql(f"PRAGMA user_version = {version}")
        _Session = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


def session() -> Session:
    engine()
    assert _Session is not None
    return _Session()
