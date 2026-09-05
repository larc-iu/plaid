"""Cross-database tables (WALS given Grambank and the reverse) and the name lookups
that work across both. Ported from dig4el's ``libs/grambank_wals_utils.py``
(Sebastien Christian, AGPL-3.0)."""

from __future__ import annotations

from typing import Any

from . import grambank as gu
from . import wals as wu
from .paths import reference_dir
from .util import load_cpt, normalize_column

_state: dict[str, Any] = {}


def _load() -> None:
    if _state:
        return
    d = reference_dir()
    _state["grambank_given_wals_cpt"] = load_cpt(d / "grambank_given_wals_cpt.json")
    _state["wals_given_grambank_cpt"] = load_cpt(d / "wals_given_grambank_cpt.json")


def __getattr__(name: str) -> Any:
    if name in ("grambank_given_wals_cpt", "wals_given_grambank_cpt"):
        _load()
        return _state[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def compute_grambank_given_wals_cp(pid, ppk):
    """P(Grambank parameter pid | WALS parameter ppk): rows are pid values, columns ppk values."""
    if ppk not in wu.parameter_name_by_pk or pid not in gu.grambank_param_value_dict:
        return None
    ppk_list = wu.domain_elements_pk_by_parameter_pk[ppk]
    pid_list = list(gu.grambank_param_value_dict[pid]["pvalues"].keys())
    filtered = __getattr__("grambank_given_wals_cpt").loc[pid_list][ppk_list]
    if filtered.max().max() == 0:
        return None
    return filtered.apply(normalize_column, axis=0)


def compute_wals_given_grambank_cp(ppk, pid):
    """P(WALS parameter ppk | Grambank parameter pid): rows are ppk values, columns pid values."""
    if ppk not in wu.parameter_name_by_pk or pid not in gu.grambank_param_value_dict:
        return None
    ppk_list = list(wu.domain_elements_pk_by_parameter_pk[ppk])
    pid_list = list(gu.grambank_param_value_dict[pid]["pvalues"].keys())
    filtered = __getattr__("wals_given_grambank_cpt").loc[ppk_list][pid_list]
    if filtered.max().max() == 0:
        return None
    return filtered.apply(normalize_column, axis=0)


def get_pname_from_pcode(pcode):
    if pcode in wu.parameter_name_by_pk:
        return wu.parameter_name_by_pk[pcode]
    if pcode in gu.grambank_param_value_dict:
        return gu.grambank_param_value_dict[pcode]["pname"]
    return None


def get_pname_from_value_code(value_code: str) -> str:
    """The parameter name a value code belongs to; "unknown" when it is in neither database."""
    if value_code[:2] == "GB":
        return get_pname_from_pcode(value_code.split("-")[0]) or "unknown"
    ppk = wu.param_pk_by_de_pk.get(value_code)
    if ppk is None:
        return "unknown"
    return wu.parameter_name_by_pk.get(str(ppk), "unknown")


def get_pvalue_name_from_value_code(code: str) -> str:
    if code[:2] == "GB":
        return gu.grambank_vname_by_vid.get(code, code)
    return wu.get_careful_name_of_de_pk(code)


def is_grambank_code(code: str) -> bool:
    return code[:2] == "GB"


def get_language_family_by_language_name(lname: str) -> str | None:
    if lname in wu.language_pk_id_by_name:
        lid = wu.language_pk_id_by_name[lname]["id"]
        return wu.language_info_by_id.get(lid, {}).get("family")
    for lid, info in gu.grambank_language_by_lid.items():
        if info.get("name") == lname:
            return info.get("family")
    return None
