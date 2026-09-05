"""WALS derived tables and the functions the inference engine calls on them.

Ported from dig4el's ``libs/wals_utils.py`` (Sebastien Christian, AGPL-3.0). The
tables are loaded lazily on first attribute access so importing the package does
not read 60 MB of JSON, and the module keeps the attribute names the engine uses
(``wu.parameter_pk_by_name``, ``wu.cpt`` and so on).
"""

from __future__ import annotations

from typing import Any

from .paths import reference_dir
from .util import load_cpt, load_json, normalize_column

_TABLES = {
    "parameter_pk_by_name": "parameter_pk_by_name_lookup_table.json",
    "parameter_pk_by_name_filtered": "parameter_pk_by_name_filtered.json",
    "language_by_pk": "language_by_pk_lookup_table.json",
    "domain_elements_by_language": "domain_elements_by_language.json",
    "domain_elements_pk_by_parameter_pk": "domain_elements_pk_by_parameter_pk_lookup_table.json",
    "domain_element_by_pk": "domain_element_by_pk_lookup_table.json",
    "language_pk_by_family": "language_pk_by_family.json",
    "language_pk_by_subfamily": "language_pk_by_subfamily.json",
    "language_pk_by_genus": "language_pk_by_genus.json",
    "language_pk_by_macroarea": "language_pk_by_macroarea.json",
    "language_pk_id_by_name": "language_pk_id_by_name.json",
    "value_by_domain_element_pk": "value_by_domain_element_pk_lookup_table.json",
    "valueset_by_pk": "valueset_by_pk_lookup_table.json",
    "n_param_by_language_id": "n_param_by_language_id.json",
    "language_info_by_id": "language_info_by_id_lookup_table.json",
    "param_pk_by_de_pk": "param_pk_by_de_pk.json",
    "params_pk_by_language_pk": "params_pk_by_language_pk.json",
    "language_pk_by_id": "language_pk_by_id.json",
}
_DERIVED = ("cpt", "parameter_name_by_pk")

_state: dict[str, Any] = {}


def _load() -> None:
    if _state:
        return
    d = reference_dir() / "wals_derived"
    for attr, fname in _TABLES.items():
        _state[attr] = load_json(d / fname)
    _state["cpt"] = load_cpt(d / "de_conditional_probability_df.json")
    _state["parameter_name_by_pk"] = {
        str(pk): name for name, pk in _state["parameter_pk_by_name"].items()
    }


def __getattr__(name: str) -> Any:
    if name in _TABLES or name in _DERIVED:
        _load()
        return _state[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def loaded() -> bool:
    return bool(_state)


def get_careful_name_of_de_pk(depk) -> str:
    """The display name of a WALS value (domain element), falling back to its description or pk."""
    info = __getattr__("domain_element_by_pk").get(str(depk), {})
    for key in ("name", "description"):
        v = info.get(key)
        if v not in (None, "") and str(v).lower() != "nan":
            return str(v)
    return str(depk)


def extract_wals_cp_matrix_from_general_data(ppk1, ppk2, active_wals_cpt=None):
    """The conditional probability matrix P(p1 | p2) as a DataFrame (rows: p1 values,
    columns: p2 values), each column normalized to sum to 1. A column with no
    information becomes uniform."""
    de_by_ppk = __getattr__("domain_elements_pk_by_parameter_pk")
    if str(ppk1) not in de_by_ppk or str(ppk2) not in de_by_ppk:
        return None
    cpt = active_wals_cpt if active_wals_cpt is not None else __getattr__("cpt")
    p1_de_pk_list = de_by_ppk[str(ppk1)]
    p2_de_pk_list = de_by_ppk[str(ppk2)]
    filtered = cpt.loc[p1_de_pk_list][p2_de_pk_list]
    return filtered.apply(normalize_column, axis=0)


def compute_wals_param_distribution(parameter_pk, language_whitelist) -> dict[str, float]:
    """The empirical distribution of a parameter's values over the whitelisted languages."""
    de_by_ppk = __getattr__("domain_elements_pk_by_parameter_pk")
    value_by_de = __getattr__("value_by_domain_element_pk")
    valueset_by_pk = __getattr__("valueset_by_pk")
    whitelist = set(str(x) for x in language_whitelist)
    param_distribution: dict[str, float] = {}
    total_count = 0
    if str(parameter_pk) not in de_by_ppk:
        return param_distribution
    for de_pk in de_by_ppk[str(parameter_pk)]:
        c = 0
        for valueset in value_by_de.get(str(de_pk), []):
            vs = valueset_by_pk.get(str(valueset["valueset_pk"]), {})
            if "language_pk" in vs and str(vs["language_pk"]) in whitelist:
                c += 1
                total_count += 1
        param_distribution[str(de_pk)] = c
    if total_count:
        for de_pk in param_distribution:
            param_distribution[de_pk] = param_distribution[de_pk] / total_count
    return param_distribution


def get_language_pks_by_family(family):
    return __getattr__("language_pk_by_family").get(family)


def get_language_pks_by_subfamily(subfamily):
    return __getattr__("language_pk_by_subfamily").get(subfamily, [])


def get_language_pks_by_genus(genus):
    return __getattr__("language_pk_by_genus").get(genus, [])


def get_language_pks_by_macroarea(macroarea):
    return __getattr__("language_pk_by_macroarea").get(macroarea, [])


def language_pk_for_name(language_name: str) -> str | None:
    """The WALS language pk for a WALS language name, or None when WALS has no such language."""
    entry = __getattr__("language_pk_id_by_name").get(language_name)
    if not entry:
        return None
    pk = entry.get("pk")
    return None if pk is None else str(pk)


def known_values_for_language_pk(language_pk: str) -> dict[str, dict[str, str]]:
    """WALS parameter values documented for a language, keyed by parameter name.

    Each value is ``{"value": <value name>, "code": <domain element pk>}``.
    """
    de_by_language = __getattr__("domain_elements_by_language")
    param_pk_by_de_pk = __getattr__("param_pk_by_de_pk")
    name_by_pk = __getattr__("parameter_name_by_pk")
    known: dict[str, dict[str, str]] = {}
    for de_pk in de_by_language.get(str(language_pk), []):
        ppk = param_pk_by_de_pk.get(str(de_pk))
        if ppk is None:
            continue
        pname = name_by_pk.get(str(ppk))
        if pname is None:
            continue
        known[pname] = {"value": get_careful_name_of_de_pk(de_pk), "code": str(de_pk)}
    return known
