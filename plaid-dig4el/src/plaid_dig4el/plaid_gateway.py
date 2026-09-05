"""Everything dig4el does to Plaid.

A language is a Plaid project. A questionnaire translation is a document born with
one placeholder sentence per segment (a partitioning sentence layer over a text of
newlines); filling a segment replaces its slot's whole range, which Plaid's
``replace`` edit keeps as the same token. Words are tokens under the sentence,
word–concept connections are spans over word tokens in the ``Concept`` layer, and
the prompt, alternate pivot, back-translation and note are sentence-scope span
layers that igt shows as fields.

The substrate carries the shared ``plaid.role`` tags, so igt can open these
documents and gloss them; everything dig4el-specific sits under the ``dig4el``
namespace, which other apps ignore.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

from plaid_client import PlaidClient

from .inference import tokenizer
from .reference import catalog
from .reference.catalog import Questionnaire, Segment

NS = "dig4el"
PLAID_NS = "plaid"
IGT_NS = "igt"

# Sentence-scope fields, in the order they appear. Each becomes a span layer on the
# sentence layer, declared as an igt sentence field so a linguist glossing the same
# text in igt sees them.
SENTENCE_FIELDS = {
    "prompt": "Prompt",
    "alternate_pivot": "Alternate pivot",
    "back_translation": "Back-translation",
    "note": "Note",
}
CONCEPT_LAYER = "Concept"


@dataclass
class Layers:
    text: str
    sentence: str
    word: str
    concept: str
    fields: dict[str, str]  # field key -> span layer id

    def to_config(self) -> dict[str, Any]:
        return {"text": self.text, "sentence": self.sentence, "word": self.word,
                "concept": self.concept, "fields": dict(self.fields)}

    @classmethod
    def from_config(cls, cfg: dict[str, Any]) -> "Layers":
        return cls(text=cfg["text"], sentence=cfg["sentence"], word=cfg["word"],
                   concept=cfg["concept"], fields=dict(cfg["fields"]))


# ---------------------------------------------------------------- project setup


def create_language_project(client: PlaidClient, name: str, language: dict[str, Any]) -> tuple[str, Layers]:
    """Create the project and its layer schema for one language. ``language`` is the
    dig4el-side record (glottocode, WALS/Grambank names, pivot language) stored in the
    project config so the project is self-describing."""
    with client.operation(f'Set up language "{name}"'):
        project = client.projects.create(name)
        pid = project["id"]
        text = client.text_layers.create(pid, "Text")
        client.text_layers.set_config(text["id"], PLAID_NS, "role", "baseline")
        sentence = client.token_layers.create(text["id"], "Sentence", overlap_mode="partitioning")
        client.token_layers.set_config(sentence["id"], PLAID_NS, "role", "sentence")
        word = client.token_layers.create(
            text["id"], "Word", overlap_mode="non-overlapping", parent_token_layer_id=sentence["id"]
        )
        client.token_layers.set_config(word["id"], PLAID_NS, "role", "word")
        concept = client.span_layers.create(word["id"], CONCEPT_LAYER)
        client.span_layers.set_config(concept["id"], NS, "kind", "concept")
        fields: dict[str, str] = {}
        for key, label in SENTENCE_FIELDS.items():
            layer = client.span_layers.create(sentence["id"], label)
            client.span_layers.set_config(layer["id"], IGT_NS, "scope", "Sentence")
            client.span_layers.set_config(layer["id"], NS, "field", key)
            fields[key] = layer["id"]
        layers = Layers(text=text["id"], sentence=sentence["id"], word=word["id"],
                        concept=concept["id"], fields=fields)
        client.projects.set_config(pid, NS, "layers", layers.to_config())
        client.projects.set_config(pid, NS, "language", language)
    return pid, layers


def read_layers(project: dict[str, Any]) -> Layers:
    return Layers.from_config(project["config"][NS]["layers"])


# ------------------------------------------------------- questionnaire documents


def create_questionnaire_document(client: PlaidClient, project_id: str, layers: Layers,
                                  q: Questionnaire) -> dict[str, Any]:
    """A document with one empty slot per segment, each slot carrying its prompt."""
    n = len(q.segments)
    with client.operation(f'Add questionnaire "{q.short_title}"'):
        doc = client.documents.create(
            project_id, q.short_title,
            metadata={NS: {"kind": "questionnaire", "questionnaire": q.uid, "published": False}},
        )
        text = client.texts.create(layers.text, doc["id"], "\n" * n)
        toks = client.tokens.bulk_create([
            {
                "token_layer_id": layers.sentence, "text": text["id"], "begin": i, "end": i + 1,
                "metadata": {NS: {"questionnaire": q.uid, "segment": s.index,
                                  "legacyIndex": s.legacy_index, "speaker": s.speaker}},
            }
            for i, s in enumerate(q.segments)
        ])
        client.spans.bulk_create([
            {"span_layer_id": layers.fields["prompt"], "tokens": [tid], "value": s.text}
            for tid, s in zip(toks["ids"], q.segments)
        ])
    return doc


# --------------------------------------------------------------- reading a doc


@dataclass
class Slot:
    """One segment of a questionnaire document as it stands in Plaid."""

    token_id: str
    begin: int
    end: int
    segment_index: str
    questionnaire: str
    speaker: str
    text: str  # the translation (slot content without its trailing newline)
    fields: dict[str, tuple[str | None, str]]  # field key -> (span id, value)
    words: list[dict[str, Any]]  # word tokens in order: {id, begin, end, form}
    concepts: list[dict[str, Any]]  # concept spans: {id, value, tokens}

    @property
    def filled(self) -> bool:
        return self.text != ""

    @property
    def segment(self) -> Segment | None:
        q = catalog.questionnaires().get(self.questionnaire)
        return q.segment(self.segment_index) if q else None


@dataclass
class QuestionnaireDoc:
    id: str
    name: str
    version: int
    text_id: str
    body: str
    questionnaire: str
    published: bool
    slots: list[Slot]

    def slot(self, segment_index: str) -> Slot | None:
        for s in self.slots:
            if s.segment_index == segment_index:
                return s
        return None


def _find(items: Iterable[dict], key: str, value: str) -> dict | None:
    for it in items:
        if it.get(key) == value:
            return it
    return None


def read_questionnaire_document(client: PlaidClient, document_id: str, layers: Layers) -> QuestionnaireDoc:
    d = client.documents.get(document_id, include_body=True)
    tl = _find(d["text_layers"], "id", layers.text)
    text = tl.get("text") or {}
    body = text.get("body", "")
    sentence_layer = _find(tl.get("token_layers", []), "id", layers.sentence) or {}
    word_layer = _find(tl.get("token_layers", []), "id", layers.word) or {}
    concept_layer = _find(word_layer.get("span_layers", []), "id", layers.concept) or {}
    field_layers = {key: _find(sentence_layer.get("span_layers", []), "id", lid) or {}
                    for key, lid in layers.fields.items()}

    words = sorted(word_layer.get("tokens", []), key=lambda t: (t["begin"], t.get("precedence") or 0, t["end"]))
    concept_spans = concept_layer.get("spans", [])
    spans_by_token: dict[str, list[dict]] = {}
    for sp in concept_spans:
        for tid in sp["tokens"]:
            spans_by_token.setdefault(tid, []).append(sp)

    slots: list[Slot] = []
    for tok in sorted(sentence_layer.get("tokens", []), key=lambda t: t["begin"]):
        meta = (tok.get("metadata") or {}).get(NS, {})
        content = body[tok["begin"]:tok["end"]]
        if content.endswith("\n"):
            content = content[:-1]
        slot_words = [
            {"id": w["id"], "begin": w["begin"], "end": w["end"], "form": body[w["begin"]:w["end"]]}
            for w in words if w["begin"] >= tok["begin"] and w["end"] <= tok["end"]
        ]
        word_ids = {w["id"] for w in slot_words}
        seen: set[str] = set()
        slot_concepts = []
        for w in slot_words:
            for sp in spans_by_token.get(w["id"], []):
                if sp["id"] in seen:
                    continue
                seen.add(sp["id"])
                slot_concepts.append({"id": sp["id"], "value": sp["value"],
                                      "tokens": [t for t in sp["tokens"] if t in word_ids]})
        fields: dict[str, tuple[str | None, str]] = {}
        for key, fl in field_layers.items():
            sp = next((s for s in fl.get("spans", []) if tok["id"] in s["tokens"]), None)
            fields[key] = (sp["id"], sp["value"] or "") if sp else (None, "")
        slots.append(Slot(
            token_id=tok["id"], begin=tok["begin"], end=tok["end"],
            segment_index=str(meta.get("segment", "")), questionnaire=str(meta.get("questionnaire", "")),
            speaker=str(meta.get("speaker", "")), text=content, fields=fields,
            words=slot_words, concepts=slot_concepts,
        ))
    dmeta = (d.get("metadata") or {}).get(NS, {})
    return QuestionnaireDoc(
        id=d["id"], name=d["name"], version=d["version"], text_id=text.get("id"), body=body,
        questionnaire=str(dmeta.get("questionnaire", slots[0].questionnaire if slots else "")),
        published=bool(dmeta.get("published", False)), slots=slots,
    )


# --------------------------------------------------------------- writing a slot


def tokenize_with_offsets(text: str, delimiters: list[str]) -> list[tuple[int, int, str]]:
    """Word tokens as (begin, end, form) in code points, splitting on the language's
    delimiters and trimming edge punctuation exactly as dig4el's tokenizer does, so the
    forms line up with ``custom_split`` on the same text."""
    pattern = "|".join(map(re.escape, delimiters))
    strip_chars = "".join(tokenizer._PUNCTUATION)
    out: list[tuple[int, int, str]] = []
    pos = 0
    pieces = re.split(f"({pattern})", text) if pattern else [text]
    for piece in pieces:
        if piece == "" or (pattern and re.fullmatch(pattern, piece)):
            pos += len(piece)
            continue
        stripped = piece.strip(strip_chars)
        if stripped:
            lead = len(piece) - len(piece.lstrip(strip_chars))
            begin = pos + lead
            out.append((begin, begin + len(stripped), stripped))
        pos += len(piece)
    return out


def fill_slot(client: PlaidClient, doc: QuestionnaireDoc, slot: Slot, text: str,
              delimiters: list[str], fields: dict[str, str] | None = None,
              concept_words: dict[str, list[int]] | None = None,
              description: str | None = None) -> None:
    """Replace a slot's translation, retokenize its words, and write its fields.

    ``concept_words`` maps a concept to the indices of the words (in the new
    tokenization) that express it. Any existing words and concept links in the slot
    are replaced: a translation edit is a re-elicitation of that segment.
    """
    text = text.replace("\n", " ").strip()
    new_content = text + "\n"
    with client.operation(description or f"Translate segment {slot.segment_index}"):
        client.texts.update(doc.text_id, [
            {"type": "replace", "index": slot.begin, "length": slot.end - slot.begin, "value": new_content}
        ])
        if text:
            words = tokenize_with_offsets(text, delimiters)
            layers = _layers_of(client, doc)
            toks = client.tokens.bulk_create([
                {"token_layer_id": layers.word, "text": doc.text_id,
                 "begin": slot.begin + b, "end": slot.begin + e}
                for b, e, _ in words
            ])["ids"] if words else []
            if concept_words:
                spans = []
                for concept, idxs in concept_words.items():
                    tids = [toks[i] for i in idxs if 0 <= i < len(toks)]
                    if tids:
                        spans.append({"span_layer_id": layers.concept, "tokens": tids, "value": concept})
                if spans:
                    client.spans.bulk_create(spans)
        if fields:
            write_fields(client, doc, slot, fields)


def _layers_of(client: PlaidClient, doc: QuestionnaireDoc) -> Layers:
    # The document read carries the layer ids; re-read project config when missing.
    if getattr(doc, "_layers", None) is None:
        project_id = client.documents.get(doc.id)["project"]
        doc._layers = read_layers(client.projects.get(project_id))  # type: ignore[attr-defined]
    return doc._layers  # type: ignore[attr-defined]


def write_fields(client: PlaidClient, doc: QuestionnaireDoc, slot: Slot, values: dict[str, str]) -> None:
    """Set or clear the sentence-scope fields of one slot."""
    layers = _layers_of(client, doc)
    for key, value in values.items():
        if key not in layers.fields:
            continue
        span_id, current = slot.fields.get(key, (None, ""))
        value = (value or "").strip()
        if value == current:
            continue
        if span_id and value:
            client.spans.update(span_id, value)
        elif span_id and not value:
            client.spans.delete(span_id)
        elif value:
            client.spans.create(layers.fields[key], [slot.token_id], value)


def set_concepts(client: PlaidClient, doc: QuestionnaireDoc, slot: Slot,
                 concept_words: dict[str, list[str]]) -> None:
    """Replace the slot's concept links. ``concept_words`` maps a concept to word token ids."""
    layers = _layers_of(client, doc)
    with client.operation(f"Link concepts in segment {slot.segment_index}"):
        existing = {c["value"]: c for c in slot.concepts}
        for concept, tids in concept_words.items():
            cur = existing.pop(concept, None)
            tids = [t for t in tids if t in {w["id"] for w in slot.words}]
            if cur and not tids:
                client.spans.delete(cur["id"])
            elif cur and sorted(cur["tokens"]) != sorted(tids):
                client.spans.set_tokens(cur["id"], tids)
            elif not cur and tids:
                client.spans.create(layers.concept, tids, concept)
        # concepts no longer mentioned are left alone


def set_published(client: PlaidClient, document_id: str, published: bool) -> None:
    """Flip the publication flag. Plaid's metadata patch replaces a nested object
    wholesale, so the namespace is read and rewritten with the flag changed."""
    current = (client.documents.get(document_id).get("metadata") or {}).get(NS) or {}
    current = dict(current)
    current["published"] = published
    client.documents.patch_metadata(document_id, {NS: current})


# ------------------------------------------------------- Plaid -> knowledge graph


def kg_word_forms(forms: list[str]) -> list[str | None]:
    """The knowledge-graph word for each token: lowercased, edge punctuation trimmed,
    repeats suffixed ``_2``, ``_3``... in order, exactly as ``custom_split`` would
    produce over the same sequence. A token that is only punctuation gets None."""
    counts: dict[str, int] = {}
    out: list[str | None] = []
    for form in forms:
        w = form.strip("".join(tokenizer._PUNCTUATION)).strip().lower()
        if not w:
            out.append(None)
            continue
        counts[w] = counts.get(w, 0) + 1
        out.append(w if counts[w] == 1 else f"{w}_{counts[w]}")
    return out


KG_DELIMITERS = [" "]


def knowledge_graph_from_docs(docs: list[QuestionnaireDoc], language_name: str,
                              published_only: bool = True) -> dict[int, dict]:
    """A knowledge graph in the observers' shape, from questionnaire documents.

    The translation string handed to the observers is the words joined by single
    spaces, and callers pass ``KG_DELIMITERS`` as the delimiters, so the observers'
    own tokenizer reproduces exactly the words stored in Plaid.
    """
    kg: dict[int, dict] = {}
    counter = 0
    for doc in docs:
        if published_only and not doc.published:
            continue
        q = catalog.questionnaires().get(doc.questionnaire)
        if q is None:
            continue
        for slot in doc.slots:
            seg = slot.segment
            if seg is None or not slot.filled:
                continue
            forms = [w["form"] for w in slot.words]
            kg_words = kg_word_forms(forms)
            by_token = {w["id"]: kw for w, kw in zip(slot.words, kg_words)}
            concept_words: dict[str, str] = {}
            for c in seg.expected_concepts():
                concept_words[c] = ""
            for sp in slot.concepts:
                ws = [by_token.get(t) for t in sp["tokens"]]
                ws = [w for w in ws if w]
                if ws:
                    concept_words[sp["value"]] = "...".join(ws)
            speaker, listener = (("A", "B") if seg.speaker == "A" else ("B", "A"))
            kg[counter] = {
                "speaker_gender": q.speakers.get(speaker, {}).get("gender"),
                "speaker_age": q.speakers.get(speaker, {}).get("age"),
                "listener_gender": q.speakers.get(listener, {}).get("gender"),
                "listener_age": q.speakers.get(listener, {}).get("age"),
                "sentence_data": seg.sentence_data(),
                "recording_data": {
                    "legacy index": seg.legacy_index,
                    "cq": seg.text,
                    "alternate_pivot": slot.fields.get("alternate_pivot", (None, ""))[1],
                    "translation": " ".join(w for w in kg_words if w) if kg_words else slot.text,
                    "concept_words": concept_words,
                    "lebt": slot.fields.get("back_translation", (None, ""))[1],
                    "comment": slot.fields.get("note", (None, ""))[1],
                    "document": doc.id,
                    "token": slot.token_id,
                },
                "language": language_name,
            }
            counter += 1
    return kg


# ----------------------------------------------------- legacy import (recordings)


def resolve_segments_for_kg(kg: dict) -> dict[Any, Segment | None]:
    """Match legacy knowledge-graph entries to catalog segments by prompt text,
    disambiguating repeated prompts by the questionnaire of the previous entry."""
    out: dict[Any, Segment | None] = {}
    prev_uid: str | None = None
    for key in sorted(kg.keys(), key=lambda k: int(k)):
        text = kg[key]["sentence_data"]["text"]
        cands = catalog.find_segments_by_text(text)
        seg = None
        if len(cands) == 1:
            seg = cands[0]
        elif cands:
            seg = next((c for c in cands if c.uid == prev_uid), cands[0])
        out[key] = seg
        if seg:
            prev_uid = seg.uid
    return out


def import_legacy_kg(client: PlaidClient, project_id: str, layers: Layers, kg: dict,
                     delimiters: list[str], publish: bool = True) -> list[dict[str, str]]:
    """Import a dig4el knowledge graph (translations with concept words) as
    questionnaire documents. Returns ``[{"uid": questionnaire uid, "id": document id}]``."""
    seg_for = resolve_segments_for_kg(kg)
    by_uid: dict[str, list[tuple[Any, Segment]]] = {}
    for key, seg in seg_for.items():
        if seg is not None:
            by_uid.setdefault(seg.uid, []).append((key, seg))
    created: list[dict[str, str]] = []
    for uid, entries in by_uid.items():
        q = catalog.questionnaires()[uid]
        doc_meta = create_questionnaire_document(client, project_id, layers, q)
        doc = read_questionnaire_document(client, doc_meta["id"], layers)
        doc._layers = layers  # type: ignore[attr-defined]
        for key, seg in entries:
            rd = kg[key]["recording_data"]
            translation = rd.get("translation", "")
            if not translation:
                continue
            slot = doc.slot(seg.index)
            if slot is None:
                continue
            words = tokenize_with_offsets(translation, delimiters)
            kg_words = kg_word_forms([w[2] for w in words])
            index_of = {w: i for i, w in enumerate(kg_words) if w}
            concept_words: dict[str, list[int]] = {}
            for concept, expr in (rd.get("concept_words") or {}).items():
                idxs = [index_of[w] for w in expr.split("...") if w in index_of] if expr else []
                if idxs:
                    concept_words[concept] = idxs
            fields = {
                "alternate_pivot": rd.get("alternate_pivot", ""),
                "back_translation": rd.get("lebt", ""),
                "note": rd.get("comment", ""),
            }
            fill_slot(client, doc, slot, translation, delimiters, fields=fields,
                      concept_words=concept_words,
                      description=f"Import segment {seg.index} of {q.short_title}")
            # offsets moved: re-read the document before the next slot
            doc = read_questionnaire_document(client, doc.id, layers)
            doc._layers = layers  # type: ignore[attr-defined]
        if publish:
            set_published(client, doc.id, True)
        created.append({"uid": uid, "id": doc.id})
    return created
