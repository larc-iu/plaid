"""The knowledge graph the observers read, and the helpers they call on it.

A knowledge graph is dig4el's merged view of a language's questionnaire
translations: ``{entry_index: {"sentence_data": <segment>, "recording_data":
<translation, concept_words, ...>, "language": <name>, ...}}``. The observers in
``legacy/cq_observers.py`` take one of these. Two builders produce it: this
module's :func:`from_recordings` (dig4el's own recording files, used by the parity
test) and ``plaid_kg.from_documents`` (Plaid documents, the live path).

Helpers ported from ``libs/knowledge_graph_utils.py`` (Sebastien Christian, AGPL-3.0).
"""

from __future__ import annotations

from typing import Any

from ..reference import catalog
from . import tokenizer as stats

IPKS = ["QUANTIFIER", "ASPECT", "EVENT TENSE", "POLARITY", "DEFINITENESS"]
RPKS = ["AGENT", "PATIENT", "OBLIQUE", "POSSESSOR", "POSSESSEE"]


def from_recordings(recordings: list[dict], language: str) -> dict[int, dict]:
    """Merge dig4el recording files (one per questionnaire) into a knowledge graph,
    exactly as ``consolidate_cq_transcriptions`` did: a segment enters the graph only
    when the recording's stored prompt matches the catalog's prompt."""
    catalog_qs = catalog.questionnaires()
    kg: dict[int, dict] = {}
    counter = 0
    for rec in recordings:
        q = catalog_qs.get(str(rec.get("cq_uid")))
        if q is None:
            continue
        for seg in q.segments:
            data = rec.get("data", {}).get(seg.index)
            if not data or data.get("cq") != seg.text:
                continue
            speaker, listener = (("A", "B") if seg.speaker == "A" else ("B", "A"))
            kg[counter] = {
                "speaker_gender": q.speakers.get(speaker, {}).get("gender"),
                "speaker_age": q.speakers.get(speaker, {}).get("age"),
                "listener_gender": q.speakers.get(listener, {}).get("gender"),
                "listener_age": q.speakers.get(listener, {}).get("age"),
                "sentence_data": seg.sentence_data(),
                "recording_data": data,
                "language": language,
            }
            counter += 1
    return kg


def get_kg_entry_signature(knowledge_graph, entry_index) -> dict[str, Any]:
    sd = knowledge_graph[entry_index]["sentence_data"]
    is_positive_polarity = True
    is_wildcard = False
    is_ref = False
    for concept in sd["concept"]:
        if "wildcard" in concept:
            is_wildcard = True
        if concept[:3] == "Ref" or concept[:2] == "PP":
            is_ref = True
    for concept, props in sd["graph"].items():
        if concept.endswith("POLARITY") and props.get("value") == "NEGATIVE":
            is_positive_polarity = False
    return {
        "intent": sd["intent"],
        "predicate": sd["predicate"],
        "polarity": is_positive_polarity,
        "is_wildcard": is_wildcard,
        "is_ref": is_ref,
    }


def get_kg_entry_polarity(kg_entry) -> str:
    for concept_name, data in kg_entry["sentence_data"]["graph"].items():
        if "POLARITY" in concept_name and data.get("value") == "NEGATIVE":
            return "NEGATIVE"
    return "POSITIVE"


def get_concept_word_pos(kg, entry_index, delimiters) -> dict[str, dict]:
    """For each concept linked to words, the position of its FIRST word in the
    tokenized translation (the observers compare these positions for word order)."""
    target_words = stats.custom_split(kg[entry_index]["recording_data"]["translation"], delimiters)
    concept_words_dict = kg[entry_index]["recording_data"]["concept_words"]
    out: dict[str, dict] = {}
    for concept, target_expression in concept_words_dict.items():
        target_word = target_expression.split("...")[0]
        if target_word in target_words:
            out[concept] = {
                "concept": concept,
                "target_word": target_word,
                "pos": target_words.index(target_word),
            }
    return out


def get_kg_entry_from_pivot_sentence(kg, pivot_sentence) -> dict:
    """The LAST entry whose prompt equals the pivot sentence (dig4el's semantics), or {}."""
    output: dict = {}
    for entry_index, data in kg.items():
        if data["sentence_data"]["text"] == pivot_sentence:
            output = {"entry_index": entry_index, "data": data}
    return output


def get_particularization_info(kg, entry, concept):
    ip: dict[str, str] = {}
    rp: dict[str, str] = {}
    cgraph = kg[entry]["sentence_data"]["graph"]
    for gkey, gdata in cgraph.items():
        if gdata.get("value", "") == "":
            continue
        if gkey.startswith(concept):
            param = gkey[len(concept) + 1 :]
            if param in IPKS:
                ip[param] = gdata["value"]
            if param in RPKS:
                rp[param] = gdata["value"]
        if gdata["value"] == concept:
            candidates = [c for c in cgraph.get("sentence", {}).get("requires", []) if c in gdata["path"]]
            if not candidates:
                continue
            gkey_concept = candidates[0]
            if gdata["path"][-1] == "REFERENCE TO CONCEPT":
                param = gdata["path"][-2]
            else:
                param = gdata["path"][-1]
            rp[param + " of"] = gkey_concept
    return ip, rp


def build_super_gloss(kg, entry, delimiters) -> list[dict[str, str]]:
    """The pseudo-gloss rows for one entry: each word with the concepts it expresses
    and their internal and relational particularizations."""
    rows: list[dict[str, str]] = []
    cw = kg[entry]["recording_data"]["concept_words"]
    for target_word in stats.custom_split(kg[entry]["recording_data"]["translation"], delimiters):
        associated = [c for c in cw if target_word in cw[c]]
        if not associated:
            rows.append(
                {"word": target_word, "concept": "", "internal particularization": "",
                 "relational particularization": ""}
            )
            continue
        for i, concept in enumerate(associated):
            ip, rp = get_particularization_info(kg, entry, concept)
            rows.append(
                {
                    "word": target_word if len(associated) == 1 else f"{target_word}({i + 1})",
                    "concept": concept,
                    "internal particularization": "+".join(f"{k}={v}" for k, v in ip.items()),
                    "relational particularization": "+".join(f"{k} {v}" for k, v in rp.items()),
                }
            )
    return rows
