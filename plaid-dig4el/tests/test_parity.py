"""Parity with dig4el's original pipeline.

The baselines under ``fixtures/`` were produced by running the untouched dig4el code
(``pages/infer_from_knowledge_and_cqs.py``'s flow, seeded) on the same knowledge
graphs. The port must reproduce them: the observer counts, the known values, the
frontier discovery, the parameters handed to the agent, and the posteriors.

Needs the derived reference data (see ``scripts/fetch_reference_data.py``); the
tests skip without it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from plaid_dig4el.inference import pipeline
from plaid_dig4el.reference import catalog
from plaid_dig4el.reference.paths import reference_dir

FIX = Path(__file__).parent / "fixtures"


def _have_reference_data() -> bool:
    try:
        reference_dir()
        return True
    except FileNotFoundError:
        return False


pytestmark = pytest.mark.skipif(not _have_reference_data(), reason="reference data not fetched")


def _load_kg(name: str) -> dict:
    with open(FIX / name, encoding="utf-8") as f:
        return {int(k): v for k, v in json.load(f).items()}


def _run(language: str, kg_file: str) -> tuple[dict, dict]:
    with open(FIX / f"baseline_{language.lower()}_seed0.json", encoding="utf-8") as f:
        baseline = json.load(f)
    report = pipeline.run_inference(_load_kg(kg_file), language, catalog.delimiters_for(language),
                                    pipeline.Settings(seed=0))
    return baseline, report


def _check(baseline: dict, report: dict) -> None:
    assert report["observations"]["counts"] == baseline["observed"]
    assert {k: v["code"] for k, v in report["known"]["wals"].items()} == baseline["known_wals_pk"]
    assert {k: v["code"] for k, v in report["known"]["grambank"].items()} == baseline["known_grambank_pid"]
    assert report["discovery"]["strong_seeds"] == baseline["strong"]
    assert [tuple(x) for x in report["discovery"]["selected"]] == [tuple(x) for x in baseline["selected"]]
    assert report["discovery"]["agent_parameters"] == baseline["ga_names"]
    by_name = {p["parameter"]: p for p in report["parameters"]}
    assert set(by_name) == set(baseline["results"])
    for pname, expected in baseline["results"].items():
        got = by_name[pname]
        assert got["origin"] == expected["origin"], pname
        assert got["winner_code"] == expected["winner"], pname
        assert got["confidence"] == expected["confidence"], pname
        for code, p in expected["beliefs"].items():
            assert abs(got["beliefs"][code]["p"] - p) < 1e-9, (pname, code)


@pytest.mark.slow
def test_tahitian_translations_only():
    """217 translations without concept links: known values, discovery and propagation."""
    _check(*_run("Tahitian", "tahitian_current_kg.json"))


@pytest.mark.slow
def test_marquesan_with_concept_links():
    """One questionnaire with concept links: the observers count word orders."""
    baseline, report = _run("Marquesan", "marquesan_kg.json")
    counts = report["observations"]["counts"]
    assert sum(counts["Order of Adjective and Noun"].values()) > 0
    _check(baseline, report)
