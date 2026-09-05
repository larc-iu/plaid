"""dig4el's own database: everything that is not the linguistic record.

The linguistic record (translations, words, concept links, fields) lives in Plaid.
This SQLite file holds the language registry, inference runs with their approvals
and overrides, and the registry of Plaid documents each language depends on.
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
    version_seen: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    missing: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    language: Mapped[Language] = relationship(back_populates="documents")


class InferenceRun(Base):
    """One run of the pipeline over a language's published translations, with the
    caretaker's review: overrides and approval. The approved run is what dig4el's
    ``cq_knowledge.json`` used to be."""

    __tablename__ = "inference_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    language_id: Mapped[str] = mapped_column(ForeignKey("languages.id"), nullable=False)
    status: Mapped[str] = mapped_column(String, nullable=False, default="queued")  # queued/running/done/failed
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
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

    @property
    def approved(self) -> bool:
        return bool(self.approved_by)


_engine = None
_Session: sessionmaker | None = None


def engine():
    global _engine, _Session
    if _engine is None:
        _engine = create_engine(f"sqlite:///{settings().db_path}", future=True,
                                connect_args={"check_same_thread": False})
        with _engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA journal_mode=WAL")
        Base.metadata.create_all(_engine)
        _Session = sessionmaker(bind=_engine, expire_on_commit=False, future=True)
    return _engine


def session() -> Session:
    engine()
    assert _Session is not None
    return _Session()
