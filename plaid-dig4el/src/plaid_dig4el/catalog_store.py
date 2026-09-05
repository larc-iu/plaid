"""The catalog (concept graph and questionnaires) kept in dig4el's database so the
expert features can edit it, seeded from the files shipped with the package."""

from __future__ import annotations

import time
from typing import Any

from . import db
from .reference import catalog


class DbSource:
    def questionnaire_documents(self) -> dict[str, dict]:
        with db.session() as s:
            rows = s.query(db.CatalogEntry).filter_by(kind="questionnaire").all()
            return {r.key: r.data for r in sorted(rows, key=lambda r: r.key)}

    def concept_graph(self) -> dict[str, Any]:
        with db.session() as s:
            row = s.get(db.CatalogEntry, "concepts")
            return dict(row.data) if row else {}


def seed_from_files() -> int:
    """Insert the bundled concept graph and questionnaires that the database lacks."""
    files = catalog.FileSource()
    added = 0
    with db.session() as s:
        if s.get(db.CatalogEntry, "concepts") is None:
            s.add(db.CatalogEntry(key="concepts", kind="concepts", data=files.concept_graph()))
            added += 1
        for uid, raw in files.questionnaire_documents().items():
            if s.get(db.CatalogEntry, uid) is None:
                s.add(db.CatalogEntry(key=uid, kind="questionnaire", data=raw))
                added += 1
        s.commit()
    return added


def install() -> None:
    seed_from_files()
    catalog.use_source(DbSource())


def save_concepts(data: dict, user_id: str) -> None:
    with db.session() as s:
        row = s.get(db.CatalogEntry, "concepts")
        row.data = dict(data)
        row.updated_by = user_id
        s.commit()
    catalog.invalidate()


def save_questionnaire(uid: str, raw: dict, user_id: str) -> None:
    with db.session() as s:
        row = s.get(db.CatalogEntry, uid)
        if row is None:
            row = db.CatalogEntry(key=uid, kind="questionnaire")
            s.add(row)
        row.data = dict(raw)
        row.updated_by = user_id
        s.commit()
    catalog.invalidate()


def new_questionnaire(title: str, user_id: str) -> str:
    """dig4el's CQ editor names a new questionnaire by the second it was started."""
    uid = str(int(time.time()))
    raw = {"uid": uid, "title": title, "short_title": title, "context": "",
           "speakers": {"A": {"name": "", "gender": "indef", "age": ""}, "B": {"name": "", "gender": "indef", "age": ""}},
           "dialog": {}}
    save_questionnaire(uid, raw, user_id)
    return uid


def delete_questionnaire(uid: str) -> None:
    with db.session() as s:
        row = s.get(db.CatalogEntry, uid)
        if row is not None:
            s.delete(row)
            s.commit()
    catalog.invalidate()
