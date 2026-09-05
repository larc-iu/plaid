"""The questionnaire catalog: the DIG4EL Conversational Questionnaires with their
per-segment concept graphs, plus the concept ontology, questionnaire titles and
per-language word delimiters. All of it ships with the package."""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from .paths import DATA_DIR, QUESTIONNAIRES_DIR


@dataclass(frozen=True)
class Segment:
    """One elicitation prompt in a questionnaire, with the concepts it is expected to express."""

    uid: str  # questionnaire uid
    index: str  # the segment key within the dialogue ("1", "2", ...)
    speaker: str
    text: str
    intent: list[str]
    predicate: list[str]
    concept: list[str]
    graph: dict[str, Any]
    legacy_index: str
    idiomaticity: int | None

    @property
    def is_negative(self) -> bool:
        return any(
            name.endswith("POLARITY") and props.get("value") == "NEGATIVE"
            for name, props in self.graph.items()
        )

    def expected_concepts(self) -> list[str]:
        """The concept list a documenter links words to, as dig4el's recorder builds it:
        intents first, "Negative Polarity" when the graph is negative, then the concepts."""
        out = list(self.intent)
        if self.is_negative:
            out.append("Negative Polarity")
        out.extend(self.concept)
        return out

    def sentence_data(self) -> dict[str, Any]:
        """The segment in the shape the observers read (``knowledge_graph[i]["sentence_data"]``)."""
        return {
            "speaker": self.speaker,
            "text": self.text,
            "intent": list(self.intent),
            "predicate": list(self.predicate),
            "concept": list(self.concept),
            "graph": self.graph,
            "legacy index": self.legacy_index,
        }


@dataclass(frozen=True)
class Questionnaire:
    uid: str
    title: str
    context: str
    speakers: dict[str, dict[str, str]]
    segments: list[Segment]

    @property
    def short_title(self) -> str:
        return titles().get(self.uid, self.title)

    def segment(self, index: str) -> Segment | None:
        for s in self.segments:
            if s.index == index:
                return s
        return None


def _segment_sort_key(k: str):
    try:
        return (0, int(k), "")
    except ValueError:
        return (1, 0, k)


@lru_cache(maxsize=1)
def questionnaires() -> dict[str, Questionnaire]:
    out: dict[str, Questionnaire] = {}
    for path in sorted(QUESTIONNAIRES_DIR.glob("*.json")):
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        segments = []
        for key in sorted(raw["dialog"].keys(), key=_segment_sort_key):
            item = raw["dialog"][key]
            segments.append(
                Segment(
                    uid=raw["uid"],
                    index=key,
                    speaker=item.get("speaker", ""),
                    text=item.get("text", ""),
                    intent=list(item.get("intent", [])),
                    predicate=list(item.get("predicate", [])),
                    concept=list(item.get("concept", [])),
                    graph=item.get("graph", {}),
                    legacy_index=str(item.get("legacy index", "")),
                    idiomaticity=item.get("idiomaticity"),
                )
            )
        out[raw["uid"]] = Questionnaire(
            uid=raw["uid"],
            title=raw["title"],
            context=raw.get("context", ""),
            speakers=raw.get("speakers", {}),
            segments=segments,
        )
    return out


@lru_cache(maxsize=1)
def titles() -> dict[str, str]:
    with open(DATA_DIR / "uid_dict.json", encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def concepts() -> dict[str, Any]:
    """The General Concept Graph shipped with dig4el."""
    with open(DATA_DIR / "concepts.json", encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def delimiters_by_language() -> dict[str, list[str]]:
    with open(DATA_DIR / "delimiters.json", encoding="utf-8") as f:
        return json.load(f)


DEFAULT_DELIMITERS = [" ", ".", ",", ";", ":", "!", "?", "…"]


def delimiters_for(language_name: str) -> list[str]:
    return delimiters_by_language().get(language_name, DEFAULT_DELIMITERS)


def find_segments_by_text(text: str) -> list[Segment]:
    """Every segment whose prompt is exactly this text (a few prompts recur across dialogues)."""
    return [s for q in questionnaires().values() for s in q.segments if s.text == text]
