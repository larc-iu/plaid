"""Concept labels have changed over dig4el's life (``PP1SG`` became ``Ref_speaker``).
Older recordings and knowledge graphs are brought up to date with the same lookup
table dig4el applies before processing, longest old name first."""

from __future__ import annotations

import copy
import json
from functools import lru_cache

from ..reference.paths import DATA_DIR


@lru_cache(maxsize=1)
def renames() -> list[tuple[str, str]]:
    with open(DATA_DIR / "concept_name_update.json", encoding="utf-8") as f:
        raw = json.load(f)
    pairs = [next(iter(entry.items())) for entry in raw]
    pairs.sort(key=lambda t: len(t[0]), reverse=True)
    return pairs


def update_concept_words(concept_words: dict) -> tuple[dict, bool]:
    cw = dict(concept_words)
    changed = False
    for old, new in renames():
        if old in cw:
            cw[new] = cw.pop(old)
            changed = True
    return cw, changed


def update_knowledge_graph(kg: dict) -> tuple[dict, bool]:
    out = copy.deepcopy(kg)
    changed_any = False
    for entry in out.values():
        cw = entry.get("recording_data", {}).get("concept_words")
        if isinstance(cw, dict):
            entry["recording_data"]["concept_words"], changed = update_concept_words(cw)
            changed_any = changed_any or changed
    return out, changed_any


@lru_cache(maxsize=1)
def display_labels() -> dict[str, str]:
    """Plain-language labels for concept ids, for the documenter's checklist."""
    with open(DATA_DIR / "terminology_conversion.json", encoding="utf-8") as f:
        return json.load(f)


def label(concept: str) -> str:
    return display_labels().get(concept, concept)
