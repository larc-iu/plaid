"""Grambank derived tables and the functions the inference engine calls on them.

Ported from dig4el's ``libs/grambank_utils.py`` (Sebastien Christian, AGPL-3.0),
lazily loaded like :mod:`.wals`.
"""

from __future__ import annotations

from typing import Any

from .paths import reference_dir
from .util import load_cpt, load_json, normalize_column

_TABLES = {
    "grambank_pname_by_pid": "grambank_pname_by_pid.json",
    "grambank_pid_by_pname": "grambank_pid_by_pname.json",
    "grambank_param_value_dict": "grambank_param_value_dict.json",
    "grambank_language_by_lid": "grambank_language_by_lid.json",
    "grambank_pvalues_by_language": "grambank_pvalues_by_language.json",
    "parameter_id_by_value_id": "parameter_id_by_value_id.json",
    "grambank_vname_by_vid": "grambank_vname_by_vid.json",
    "grambank_language_id_by_vid": "grambank_language_id_by_vid.json",
}

_state: dict[str, Any] = {}


def _load() -> None:
    if _state:
        return
    d = reference_dir() / "grambank_derived"
    for attr, fname in _TABLES.items():
        _state[attr] = load_json(d / fname)
    _state["cpt"] = load_cpt(d / "grambank_vid_conditional_probability.json")


def __getattr__(name: str) -> Any:
    if name in _TABLES or name == "cpt":
        _load()
        return _state[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def compute_grambank_param_distribution(pid, lids_list=("ALL",)) -> dict[str, float]:
    """The empirical distribution of a parameter's values over the given languages."""
    language_by_lid = __getattr__("grambank_language_by_lid")
    pvalues_by_language = __getattr__("grambank_pvalues_by_language")
    param_value_dict = __getattr__("grambank_param_value_dict")
    if list(lids_list) == ["ALL"]:
        available = set(language_by_lid.keys())
    else:
        available = set(lids_list)
    vids = list(param_value_dict[pid]["pvalues"].keys())
    param_distribution = {key: 0 for key in vids}
    for lid, pvalues in pvalues_by_language.items():
        if lid in available:
            for pvalue in pvalues:
                if pvalue in param_distribution:
                    param_distribution[pvalue] += 1
    total_count = sum(param_distribution.values())
    if total_count:
        for vid in param_distribution:
            param_distribution[vid] = param_distribution[vid] / total_count
    return param_distribution


def compute_grambank_cp_matrix_from_general_data(pid1, pid2):
    """The conditional probability matrix P(pid1 | pid2), columns normalized to 1."""
    param_value_dict = __getattr__("grambank_param_value_dict")
    if pid1 not in param_value_dict or pid2 not in param_value_dict:
        return None
    pid1_list = list(param_value_dict[pid1]["pvalues"].keys())
    pid2_list = list(param_value_dict[pid2]["pvalues"].keys())
    filtered = __getattr__("cpt").loc[pid1_list][pid2_list]
    return filtered.apply(normalize_column, axis=0)


def language_names() -> list[str]:
    """Every Grambank language name, sorted."""
    return sorted({info.get("name", "") for info in __getattr__("grambank_language_by_lid").values()} - {""})


def language_id_for_name(language_name: str) -> str | None:
    """The Grambank language id (a glottocode) for a Grambank language name."""
    for lid, info in __getattr__("grambank_language_by_lid").items():
        if info.get("name") == language_name:
            return lid
    return None


def known_values_for_language_id(language_id: str) -> dict[str, dict[str, str]]:
    """Grambank parameter values documented for a language, keyed by parameter name.

    Each value is ``{"value": <value name>, "code": <value id>}``.
    """
    pvalues_by_language = __getattr__("grambank_pvalues_by_language")
    pname_by_pid = __getattr__("grambank_pname_by_pid")
    vname_by_vid = __getattr__("grambank_vname_by_vid")
    known: dict[str, dict[str, str]] = {}
    for pvalue in pvalues_by_language.get(language_id, []):
        pid = pvalue[:5]
        pname = pname_by_pid.get(pid)
        if pname is None:
            continue
        known[pname] = {"value": vname_by_vid.get(pvalue, pvalue), "code": pvalue}
    return known
