"""Offline checks of the generation inputs: the pseudo-gloss (alterlingua) built from a
knowledge graph, the grammar priors taken from an approved run, and the seeded query."""

import json
from pathlib import Path

from plaid_dig4el import db, generation
from plaid_dig4el.inference import legacy_labels

FIX = Path(__file__).parent / "fixtures"


def test_alterlingua_from_marquesan_fixture():
    kg = {int(k): v for k, v in json.loads((FIX / "marquesan_kg.json").read_text()).items()}
    kg, _ = legacy_labels.update_knowledge_graph(kg)
    rows = generation.build_alterlingua(kg, [" "])
    assert len(rows) == len(kg)
    with_gloss = [r for r in rows if "<" in r["alterlingua"]]
    assert with_gloss, "some sentence carries a concept gloss"
    r = with_gloss[0]
    assert set(r) == {"source", "target", "alterlingua", "comments"}
    assert "(IP: | " not in r["alterlingua"] and "<>" not in r["alterlingua"]
    # every glossed word keeps its surface form before the angle bracket
    for chunk in r["alterlingua"].split(" "):
        if "<" in chunk:
            assert chunk.index("<") > 0


def test_grammar_priors_take_retained_and_overrides():
    run = db.InferenceRun(language_id="x", created_by="me", report={"parameters": [
        {"parameter": "Order of Subject, Object and Verb", "origin": "observed", "winner": "VSO", "confidence": 93,
         "retained": True, "beliefs": {"1": {"name": "SOV", "p": 0.05}, "2": {"name": "VSO", "p": 0.93}}},
        {"parameter": "Polar Questions", "origin": "inferred", "winner": "Question particle", "confidence": 40,
         "retained": False, "beliefs": {"9": {"name": "Question particle", "p": 0.4}, "10": {"name": "Interrogative verb morphology", "p": 0.3}}},
        {"parameter": "Dropped", "origin": "inferred", "winner": "x", "confidence": 10, "retained": False, "beliefs": {}},
    ]}, overrides={"Polar Questions": {"code": "10", "by": "me", "at": "now"}})
    priors = generation.grammar_priors(run)
    assert [p["Parameter"] for p in priors] == ["Order of Subject, Object and Verb", "Polar Questions"]
    assert priors[0] == {"Parameter": "Order of Subject, Object and Verb", "Origin": "Observed", "Winner": "VSO",
                         "Confidence": 93, "Examples by value": {}}
    assert priors[1]["Winner"] == "Interrogative verb morphology" and priors[1]["Confidence"] == 100


def test_seeded_query_carries_guidance():
    q = generation.seeded_query("Negation", "Tahitian")
    assert "TOPIC: Negation" in q and "INSTRUCTIONS" in q and "Tahitian" in q
    assert generation.seeded_query("Something else", "Tahitian") == "TOPIC: Something else"
