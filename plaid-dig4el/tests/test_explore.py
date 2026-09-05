"""The ported word statistics agree with dig4el's own module when its clone is present,
and the explorers read the reference tables."""

import json
import sys
from pathlib import Path

import pytest

from plaid_dig4el import explore
from plaid_dig4el.inference import legacy_labels

FIX = Path(__file__).parent / "fixtures"
DIG4EL = Path.home() / "local" / "dig4el"


def _kg():
    kg = {int(k): v for k, v in json.loads((FIX / "marquesan_kg.json").read_text()).items()}
    return legacy_labels.update_knowledge_graph(kg)[0]


def test_word_statistics_match_dig4el():
    if not (DIG4EL / "libs" / "stats.py").exists():
        pytest.skip("dig4el clone not present")
    sys.path.insert(0, str(DIG4EL))
    try:
        from libs import stats as theirs  # noqa
    except Exception as e:  # its imports may need packages we do not have
        pytest.skip(f"dig4el stats import failed: {e}")
    kg = _kg()
    ours = explore.word_statistics(kg, [" "])
    ref = theirs.build_blind_word_stats_from_knowledge_graph(kg, [" "])
    assert ours["words"] == ref
    assert abs(ours["entropy"] - theirs.compute_average_blind_entropy(ref)) < 1e-12


def test_feature_values_and_word_detail():
    from plaid_dig4el.reference import catalog

    kg = _kg()
    vl = explore.feature_values(kg, catalog.concepts(), "INTENT", [" "])
    assert sum(len(v) for v in vl.values()) > 0 and "ASK" in vl
    ws = explore.word_statistics(kg, [" "])
    top = max(ws["words"].values(), key=lambda w: w["frequency"])["word"]
    d = explore.word_detail(kg, top, [" "])
    assert d["entries"] and all(len(e) == 3 for e in d["entries"])


def test_word_network_metrics_follow_dig4el():
    words = {
        "a": {"word": "a", "frequency": 3, "following": {"b": 2, "": 1}, "preceding": {"": 3}},
        "b": {"word": "b", "frequency": 2, "following": {"c": 2}, "preceding": {"a": 2}},
    }
    n = explore.word_network(words)
    # "c" only follows; a has one real follower (b), b has one (c); in-degree counts words listing you
    assert n["total_words"] == 2 and n["follower_only"] == 1 and n["no_followers"] == 0
    assert n["total_connections"] == 3 and n["avg_connections"] == 1.5
    assert n["density"] == round(3 / (2 * 2), 4)
    hubs = {h["word"]: h for h in n["hubs"]}
    assert hubs["a"] == {"word": "a", "out": 1, "in": 0, "total": 1, "count": 3, "count_x": 3}
    assert hubs["b"]["in"] == 1 and hubs["b"]["out"] == 1


def test_comparable_sentences_need_two_languages():
    kg1 = {0: {"sentence_data": {"text": "Hello"}, "recording_data": {"translation": "ia ora na"}},
           1: {"sentence_data": {"text": "Bye"}, "recording_data": {"translation": "nana"}}}
    kg2 = {0: {"sentence_data": {"text": "Hello"}, "recording_data": {"translation": "kaoha"}}}
    comp = explore.comparable_sentences({"Tahitian": kg1, "Marquesan": kg2})
    assert list(comp) == ["Hello"] and comp["Hello"]["Marquesan"]["stl"] == "kaoha"
