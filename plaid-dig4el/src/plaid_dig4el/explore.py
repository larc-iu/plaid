"""Read-only exploration: dig4el's WALS and Grambank explorers, its conditional
probability page, and the statistics its transcription pages computed over a
language's knowledge graph."""

from __future__ import annotations

from typing import Any

from .legacy import kg_explore, stats
from .reference import bridge, grambank as gu, wals as wu

# ------------------------------------------------------------------------ WALS


def wals_language(name: str) -> dict[str, Any] | None:
    entry = wu.language_pk_id_by_name.get(name)
    if not entry:
        return None
    info = wu.language_info_by_id.get(entry["id"], {})
    values = wu.known_values_for_language_pk(str(entry["pk"]))
    return {"name": name, "id": entry["id"], "pk": str(entry["pk"]),
            "macroarea": _clean(info.get("macroarea")), "family": _clean(info.get("family")),
            "subfamily": _clean(info.get("subfamily")), "genus": _clean(info.get("genus")),
            "values": sorted(((p, v["value"]) for p, v in values.items()), key=lambda t: t[0].lower())}


def wals_compare(names: list[str]) -> tuple[list[str], list[tuple[str, list[str]]]]:
    """Parameters that at least one of the languages has a value for, as rows."""
    columns = [n for n in names if n in wu.language_pk_id_by_name]
    per = {n: wu.known_values_for_language_pk(str(wu.language_pk_id_by_name[n]["pk"])) for n in columns}
    params = sorted({p for vals in per.values() for p in vals}, key=str.lower)
    return columns, [(p, [per[n].get(p, {}).get("value", "") for n in columns]) for p in params]


def wals_parameter_counts(parameter: str, macroarea: str = "", family: str = "") -> list[tuple[str, int]]:
    """How many languages have each value of the parameter, within a macroarea or family."""
    ppk = str(wu.parameter_pk_by_name.get(parameter, ""))
    if not ppk:
        return []
    de_pks = [str(x) for x in wu.domain_elements_pk_by_parameter_pk.get(ppk, [])]
    whitelist = None
    if macroarea:
        whitelist = set(str(x) for x in wu.language_pk_by_macroarea.get(macroarea, []))
    if family:
        fam = set(str(x) for x in wu.language_pk_by_family.get(family, []))
        whitelist = fam if whitelist is None else whitelist & fam
    counts = {de: 0 for de in de_pks}
    for lpk, des in wu.domain_elements_by_language.items():
        if whitelist is not None and str(lpk) not in whitelist:
            continue
        for de in des:
            if str(de) in counts:
                counts[str(de)] += 1
    return [(wu.get_careful_name_of_de_pk(de), n) for de, n in counts.items()]


def wals_filters() -> tuple[list[str], list[str]]:
    return sorted(wu.language_pk_by_macroarea), sorted(wu.language_pk_by_family)


def wals_parameters() -> list[str]:
    return sorted(wu.parameter_pk_by_name, key=str.lower)


# -------------------------------------------------------------------- Grambank


def grambank_language(name: str) -> dict[str, Any] | None:
    lid = gu.language_id_for_name(name)
    if not lid:
        return None
    info = gu.grambank_language_by_lid.get(lid, {})
    values = gu.known_values_for_language_id(lid)
    return {"name": name, "id": lid, "macroarea": _clean(info.get("macroarea")), "family": _clean(info.get("family")),
            "glottocode": info.get("glottocode", lid),
            "values": sorted(((p, v["value"]) for p, v in values.items()), key=lambda t: t[0].lower())}


def grambank_compare(names: list[str]) -> tuple[list[str], list[tuple[str, list[str]]]]:
    columns = [n for n in names if gu.language_id_for_name(n)]
    per = {n: gu.known_values_for_language_id(gu.language_id_for_name(n)) for n in columns}
    params = sorted({p for vals in per.values() for p in vals}, key=str.lower)
    return columns, [(p, [per[n].get(p, {}).get("value", "") for n in columns]) for p in params]


def grambank_parameter_counts(parameter: str, macroarea: str = "", family: str = "") -> list[tuple[str, int]]:
    pid = gu.grambank_pid_by_pname.get(parameter)
    if not pid:
        return []
    allowed = None
    if macroarea or family:
        allowed = {lid for lid, info in gu.grambank_language_by_lid.items()
                   if (not macroarea or info.get("macroarea") == macroarea) and (not family or info.get("family") == family)}
    out = []
    for vid, v in gu.grambank_param_value_dict[pid]["pvalues"].items():
        lids = gu.grambank_language_id_by_vid.get(vid, [])
        n = len(lids) if allowed is None else sum(1 for l in lids if l in allowed)
        out.append((v["vname"], n))
    return out


def grambank_filters() -> tuple[list[str], list[str]]:
    infos = gu.grambank_language_by_lid.values()
    return (sorted({i.get("macroarea") for i in infos if i.get("macroarea")}),
            sorted({i.get("family") for i in infos if i.get("family")}))


def grambank_parameters() -> list[str]:
    return sorted(gu.grambank_pid_by_pname, key=str.lower)


# ------------------------------------------------------ conditional probabilities


def conditional_table(p1: str, p2: str) -> tuple[list[str], list[str], list[list[float]]] | None:
    """P(p1 | p2) between two parameters, WALS or Grambank on either side, as dig4el's
    conditional-probability page showed it: rows are p1's values, columns p2's."""
    w1, w2 = p1 in wu.parameter_pk_by_name, p2 in wu.parameter_pk_by_name
    g1, g2 = p1 in gu.grambank_pid_by_pname, p2 in gu.grambank_pid_by_pname
    wals_name = lambda x: wu.get_careful_name_of_de_pk(str(x))
    gb_name = lambda x: gu.grambank_vname_by_vid.get(str(x), str(x))
    if w1 and w2:
        df = wu.extract_wals_cp_matrix_from_general_data(str(wu.parameter_pk_by_name[p1]), str(wu.parameter_pk_by_name[p2]))
        row_name, col_name = wals_name, wals_name
    elif g1 and g2:
        df = gu.compute_grambank_cp_matrix_from_general_data(gu.grambank_pid_by_pname[p1], gu.grambank_pid_by_pname[p2])
        row_name, col_name = gb_name, gb_name
    elif g1 and w2:
        df = bridge.compute_grambank_given_wals_cp(gu.grambank_pid_by_pname[p1], str(wu.parameter_pk_by_name[p2]))
        row_name, col_name = gb_name, wals_name
    elif w1 and g2:
        df = bridge.compute_wals_given_grambank_cp(str(wu.parameter_pk_by_name[p1]), gu.grambank_pid_by_pname[p2])
        row_name, col_name = wals_name, gb_name
    else:
        return None
    if df is None or getattr(df, "empty", True):
        return None
    rows = [row_name(i) for i in df.index]
    cols = [col_name(c) for c in df.columns]
    return rows, cols, [[float(x) for x in row] for row in df.values.tolist()]


# ------------------------------------------------------- statistics on a language


def word_statistics(kg: dict, delimiters: list[str]) -> dict[str, Any]:
    """dig4el's blind word statistics: every word's frequency and its neighbours, with
    the average entropy of the language's transitions."""
    ws = stats.build_blind_word_stats_from_knowledge_graph(kg, delimiters)
    return {"words": ws, "entropy": stats.compute_average_blind_entropy(ws),
            "total": sum(w["frequency"] for w in ws.values())}


def word_detail(kg: dict, word: str, delimiters: list[str]) -> dict[str, Any]:
    entries = kg_explore.get_sentences_with_word(kg, word, delimiters)
    concepts = kg_explore.get_concepts_associated_to_word_by_human(kg, word, delimiters)
    return {"entries": [(i, kg[i]["sentence_data"]["text"], kg[i]["recording_data"]["translation"]) for i in entries],
            "concepts": sorted(concepts.values(), key=lambda c: -c["count"])}


def feature_values(kg: dict, cg: dict, feature: str, delimiters: list[str]) -> dict[str, list]:
    return kg_explore.get_value_loc_dict(kg, cg, feature, delimiters)


def value_detail(kg: dict, value_loc: dict[str, list], value: str, total_words: int, delimiters: list[str]) -> dict[str, Any]:
    entries = value_loc.get(value, [])
    diff = kg_explore.get_diff_word_statistics_with_value_loc_dict(kg, value_loc, value, max(total_words, 1), delimiters)
    return {"entries": [(i, kg[i]["sentence_data"]["text"], kg[i]["recording_data"]["translation"]) for i in entries],
            "diff": sorted(diff.items(), key=lambda t: -t[1])[:40]}


def _clean(v: Any) -> str:
    return "" if v is None or (isinstance(v, float) and v != v) else str(v)
