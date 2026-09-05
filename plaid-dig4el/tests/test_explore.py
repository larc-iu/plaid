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
