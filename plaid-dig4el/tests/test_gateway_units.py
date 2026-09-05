"""Offline checks on the gateway's tokenization and knowledge-graph rebuild, which must
agree with dig4el's own tokenizer so the observers see the same words."""

from __future__ import annotations

import json
from pathlib import Path

from plaid_dig4el import plaid_gateway as gw
from plaid_dig4el.inference import tokenizer
from plaid_dig4el.reference import catalog

FIX = Path(__file__).parent / "fixtures"
DELIMS = [" ", ".", ",", ";", ":", "!", "?", "…"]


def test_offsets_agree_with_custom_split_on_real_translations():
    with open(FIX / "tahitian_current_kg.json", encoding="utf-8") as f:
        kg = json.load(f)
    for entry in kg.values():
        text = entry["recording_data"]["translation"]
        toks = gw.tokenize_with_offsets(text, DELIMS)
        for b, e, form in toks:
            assert text[b:e] == form
        assert gw.kg_word_forms([t[2] for t in toks]) == tokenizer.custom_split(text, DELIMS)


def test_kg_word_forms_suffixes_repeats_and_drops_punctuation():
    assert gw.kg_word_forms(["E", "haere", "e", "!", "haere"]) == ["e", "haere", "e_2", None, "haere_2"]


def test_legacy_entries_resolve_to_catalog_segments():
    with open(FIX / "tahitian_current_kg.json", encoding="utf-8") as f:
        kg = {int(k): v for k, v in json.load(f).items()}
    seg_for = gw.resolve_segments_for_kg(kg)
    assert all(seg is not None for seg in seg_for.values())
    # repeated prompts are assigned to the questionnaire of their neighbours
    uids = [seg_for[k].uid for k in sorted(kg)]
    changes = sum(1 for a, b in zip(uids, uids[1:]) if a != b)
    assert changes == len(set(uids)) - 1


def test_expected_concepts_follow_the_recorder():
    q = catalog.questionnaires()["1716315461"]
    seg = q.segment("4")  # "I'm fine, and you?"
    assert seg.expected_concepts()[:3] == ["ASSERT", "ASK", "GREET"]
    assert "Ref_speaker" in seg.expected_concepts()
