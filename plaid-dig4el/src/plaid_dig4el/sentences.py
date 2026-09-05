"""The language's sentence pool, its augmentation job, and retrieval over it.

dig4el's sentence pairs are files under ``sentence_pairs/``; here the pool is every
sentence in the language's Plaid documents that has both sides: the target sentence
(the slot text) and its source-language equivalent (the prompt field), whether it came
from a questionnaire translation or an uploaded corpus. Augmentation describes the
source sentence (``augment.describe_sentence``) and stores the result with three
embeddings, as dig4el's ``vector_ready_pairs`` did: "source: description", the source
alone, the description alone.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

import numpy as np
from plaid_client import PlaidClient

from . import augment, db, jobs, plaid_gateway as gw
from .inference.tokenizer import custom_split
from .llm import LLM, llm

VECTOR_NAMES = ("pair", "source", "description")
WORKERS = 4


@dataclass
class PoolSentence:
    language_id: str
    document_id: str
    document_name: str
    kind: str
    token_id: str
    segment_index: str
    source: str
    target: str


def read_pool(client: PlaidClient, language: db.Language) -> tuple[list[PoolSentence], list[str]]:
    """Every sentence with both sides, across the language's questionnaire and corpus
    documents, plus the problems met reading them (in plain words)."""
    layers = gw.Layers.from_config(language.layers)
    pool: list[PoolSentence] = []
    problems: list[str] = []
    refs = [(r.plaid_document_id, "questionnaire") for r in language.documents]
    refs += [(c.plaid_document_id, "corpus") for c in language.corpora]
    for doc_id, kind in refs:
        try:
            doc = gw.read_questionnaire_document(client, doc_id, layers)
        except gw.DocumentUnavailable as e:
            problems.append(f"{kind} {doc_id}: {e}")
            continue
        for slot in doc.slots:
            source = slot.fields.get("prompt", (None, ""))[1].strip()
            if slot.filled and source:
                pool.append(PoolSentence(language.id, doc.id, doc.name, kind, slot.token_id,
                                         slot.segment_index, source, slot.text))
    return pool, problems


def vector_text(source: str, description: str) -> str:
    """dig4el's ``build_vector_ready_augmented_pair``."""
    return (source + ": " + description + ".").replace("..", ".")


def pack(vectors: list[list[float]]) -> bytes:
    arr = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=1, keepdims=True)
    return (arr / np.where(norms == 0, 1, norms)).tobytes()


def unpack(blob: bytes, dim: int) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32).reshape(len(VECTOR_NAMES), dim)


# ---------------------------------------------------------------------- the job


@jobs.handler("augment")
def run_augmentation(job: db.Job, client: PlaidClient) -> None:
    """Describe every pooled sentence that has no augmentation yet, or whose source
    changed since it was described. Sentences already described are left alone, as
    dig4el's signature check did."""
    language_id = job.payload["language_id"]
    model = job.payload.get("model") or None
    with db.session() as s:
        language = s.get(db.Language, language_id)
        _ = language.documents, language.corpora
        existing = {a.token_id: a.source for a in s.query(db.SentenceAugmentation)
                    .filter_by(language_id=language_id).all()}
    pool, problems = read_pool(client, language)
    todo = [p for p in pool if existing.get(p.token_id) != p.source]
    _progress(job.id, 0, len(todo), "; ".join(problems))
    L = llm()
    done = 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futures = {ex.submit(describe, L, p, model): p for p in todo}
        for fut in as_completed(futures):
            p = futures[fut]
            row = fut.result()  # an LLM failure fails the job
            with db.session() as s:
                old = s.query(db.SentenceAugmentation).filter_by(token_id=p.token_id).one_or_none()
                if old is not None:
                    s.delete(old)
                    s.flush()
                s.add(row)
                s.commit()
            done += 1
            _progress(job.id, done, len(todo))
    _sweep(language_id, {p.token_id for p in pool})


def describe(L: LLM, p: PoolSentence, model: str | None) -> db.SentenceAugmentation:
    d = augment.describe_sentence(L, p.source, model=model)
    a = augment.augmentation_of(d)
    vectors = L.embed([vector_text(p.source, a["description"]), p.source, a["description"]])
    return _row(p, a, model or L.model, pack(vectors))


def _row(p: PoolSentence, a: dict, model: str, vectors: bytes) -> db.SentenceAugmentation:
    return db.SentenceAugmentation(
        language_id=p.language_id, document_id=p.document_id, token_id=p.token_id, source=p.source, target=p.target,
        description=a["description"], keywords=a["keywords"],
        key_translation_concepts=a["key_translation_concepts"], comment=a["comment"],
        model=model, vectors=vectors,
    )


def _progress(job_id: str, done: int, total: int, note: str = "") -> None:
    with db.session() as s:
        job = s.get(db.Job, job_id)
        job.progress = {"done": done, "total": total, "note": note}
        s.commit()


def _sweep(language_id: str, live_tokens: set[str]) -> None:
    """Drop augmentations of sentences that no longer exist in Plaid."""
    with db.session() as s:
        for a in s.query(db.SentenceAugmentation).filter_by(language_id=language_id).all():
            if a.token_id not in live_tokens:
                s.delete(a)
        s.commit()


# ------------------------------------------------------------------- retrieval


@dataclass
class Hit:
    augmentation: db.SentenceAugmentation
    score: float
    how: str  # "keyword" or "embedding" or "model"


def keyword_hits(rows: list[db.SentenceAugmentation], query: str, delimiters: list[str]) -> list[Hit]:
    """dig4el's ``hard_retrieve_from_query``: a query word matches every keyword it is
    a substring of."""
    words = [w for w in custom_split(query, delimiters) if w]
    out = []
    for a in rows:
        matched = {kw for kw in a.keywords for w in words if w.lower() in kw.lower()}
        if matched:
            out.append(Hit(a, float(len(matched)), "keyword"))
    out.sort(key=lambda h: -h.score)
    return out


def embedding_hits(rows: list[db.SentenceAugmentation], query: str, k: int = 10,
                   which: str = "description") -> list[Hit]:
    """dig4el's ``retrieve_similar`` over one of the three indices (cosine)."""
    rows = [a for a in rows if a.vectors]
    if not rows:
        return []
    L = llm()
    q = np.asarray(L.embed([query])[0], dtype=np.float32)
    q /= np.linalg.norm(q) or 1
    dim = q.shape[0]
    idx = VECTOR_NAMES.index(which)
    matrix = np.stack([unpack(a.vectors, dim)[idx] for a in rows])
    scores = matrix @ q
    order = np.argsort(-scores)[:k]
    return [Hit(rows[i], float(scores[i]), "embedding") for i in order]


def model_selection(rows: list[db.SentenceAugmentation], query: str) -> list[Hit]:
    """dig4el's current retrieval: the Sentence Selector picks from every source."""
    by_source = {a.source: a for a in rows}
    chosen = augment.select_sentences(llm(), query, list(by_source))
    return [Hit(by_source[s], 1.0, "model") for s in chosen if s in by_source]
