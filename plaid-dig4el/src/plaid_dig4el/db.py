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

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, LargeBinary, String, Text, create_engine
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
    open_to_guests: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # readable by the guest account
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    documents: Mapped[list["QuestionnaireDocument"]] = relationship(back_populates="language",
                                                                    cascade="all, delete-orphan")
    runs: Mapped[list["InferenceRun"]] = relationship(back_populates="language",
                                                      cascade="all, delete-orphan",
                                                      order_by="InferenceRun.created_at.desc()")
    corpora: Mapped[list["CorpusDocument"]] = relationship(back_populates="language",
                                                           cascade="all, delete-orphan",
                                                           order_by="CorpusDocument.created_at")
    outputs: Mapped[list["GrammarOutput"]] = relationship(back_populates="language",
                                                          cascade="all, delete-orphan",
                                                          order_by="GrammarOutput.created_at.desc()")
    reference_documents: Mapped[list["ReferenceDocument"]] = relationship(back_populates="language",
                                                                          cascade="all, delete-orphan",
                                                                          order_by="ReferenceDocument.created_at")

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


class CorpusDocument(Base):
    """A Plaid document holding a sentence-pair corpus for a language (target sentences
    with their source-language equivalents), with the provenance dig4el asks for."""

    __tablename__ = "corpus_documents"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    language_id: Mapped[str] = mapped_column(ForeignKey("languages.id"), nullable=False)
    plaid_document_id: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    origin: Mapped[str] = mapped_column(String, nullable=False, default="")
    author: Mapped[str] = mapped_column(String, nullable=False, default="")
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    language: Mapped[Language] = relationship(back_populates="corpora")


class SentenceAugmentation(Base):
    """What the language model said about one sentence (dig4el's augmented pair): the
    facet description, keywords and key translation concepts, with the embeddings that
    index it. Keyed by the sentence's Plaid token; ``target`` and ``source`` are the
    text it described, so a changed sentence is re-described."""

    __tablename__ = "sentence_augmentations"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    language_id: Mapped[str] = mapped_column(ForeignKey("languages.id"), nullable=False)
    document_id: Mapped[str] = mapped_column(String, nullable=False)  # Plaid document
    token_id: Mapped[str] = mapped_column(String, nullable=False, unique=True)  # Plaid sentence token
    source: Mapped[str] = mapped_column(Text, nullable=False)
    target: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    keywords: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    key_translation_concepts: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    comment: Mapped[str] = mapped_column(Text, nullable=False, default="")
    model: Mapped[str] = mapped_column(String, nullable=False, default="")
    vectors: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, default=b"")  # float32 (3, dim): pair, source, description
    edited_by: Mapped[str] = mapped_column(String, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class ReferenceDocument(Base):
    """A document about the language (a grammar, an article, notes) that the generation
    stage can draw on: the file on disk under the data directory, its extracted text,
    and chunks with embeddings in ``document_chunks``. dig4el kept these in an OpenAI
    vector store; here they are indexed locally."""

    __tablename__ = "reference_documents"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    language_id: Mapped[str] = mapped_column(ForeignKey("languages.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String, nullable=False, default="uploaded")  # uploaded/indexed/failed
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
    uploaded_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    language: Mapped[Language] = relationship(back_populates="reference_documents")
    chunks: Mapped[list["DocumentChunk"]] = relationship(back_populates="document", cascade="all, delete-orphan",
                                                          order_by="DocumentChunk.index")


class DocumentChunk(Base):
    __tablename__ = "document_chunks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    document_id: Mapped[str] = mapped_column(ForeignKey("reference_documents.id"), nullable=False)
    index: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    vector: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, default=b"")  # float32, normalized

    document: Mapped[ReferenceDocument] = relationship(back_populates="chunks")


class GrammarOutput(Base):
    """A generated grammar lesson or sketch (dig4el's stored output), with the trace of
    what fed it: selected parameters, the pseudo-gloss contribution, the document
    contribution and the chosen sentence pairs."""

    __tablename__ = "grammar_outputs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    language_id: Mapped[str] = mapped_column(ForeignKey("languages.id"), nullable=False)
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id"), nullable=True)
    format: Mapped[str] = mapped_column(String, nullable=False)  # lesson / sketch
    topic: Mapped[str] = mapped_column(String, nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False, default="")
    readers_language: Mapped[str] = mapped_column(String, nullable=False, default="English")
    readers_type: Mapped[str] = mapped_column(String, nullable=False, default="Adults")
    model: Mapped[str] = mapped_column(String, nullable=False, default="")
    output: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    trace: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    language: Mapped[Language] = relationship(back_populates="outputs")
    feedback: Mapped[list["OutputFeedback"]] = relationship(back_populates="output", cascade="all, delete-orphan",
                                                            order_by="OutputFeedback.created_at")


class OutputFeedback(Base):
    """dig4el's feedback form on an output: five 0-9 ratings and a comment."""

    __tablename__ = "output_feedback"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_id)
    output_id: Mapped[str] = mapped_column(ForeignKey("grammar_outputs.id"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    errors: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completeness: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    clarity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    usefulness: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    confidence: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    comments: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)

    output: Mapped[GrammarOutput] = relationship(back_populates="feedback")


class CatalogEntry(Base):
    """An editable catalog document: the concept graph (key ``concepts``) or one
    questionnaire (key = its uid), as the JSON dig4el edits; seeded from the bundled
    files on first start."""

    __tablename__ = "catalog_entries"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    kind: Mapped[str] = mapped_column(String, nullable=False)  # concepts / questionnaire
    data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    updated_by: Mapped[str] = mapped_column(String, nullable=False, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


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
    progress: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)  # {"done": n, "total": m, "note": str}


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
    [  # 2: jobs report progress
        "ALTER TABLE jobs ADD COLUMN progress JSON NOT NULL DEFAULT '{}'",
    ],
    [  # 3: the unused members flag becomes the guest flag, off by default
        "ALTER TABLE languages RENAME COLUMN open_to_members TO open_to_guests",
        "UPDATE languages SET open_to_guests = 0",
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
