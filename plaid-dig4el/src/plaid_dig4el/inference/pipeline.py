"""The inference pipeline, as dig4el's "Infer from knowledge and CQs" page runs it.

Given a knowledge graph (a language's questionnaire translations with their
word–concept connections), the pipeline:

1. retrieves the parameter values WALS and Grambank already document for the
   language (known values);
2. runs the deterministic observers over the translations (observed values);
3. discovers which further parameters the evidence can reach, by expanding a
   frontier through the conditional-probability graph from the strongly supported
   values (frontier discovery);
4. builds a general agent over the discovered parameters, updates it with the
   observations, locks in the known values, and runs loopy belief propagation;
5. reports every parameter's distribution with its origin and confidence.

Constants and control flow follow ``pages/infer_from_knowledge_and_cqs.py``
(Sebastien Christian, AGPL-3.0). Three deliberate departures, all for
reproducibility: the parameter list handed to the agent is de-duplicated across
topics, the random traversal order can be seeded, and frontier candidates with
equal scores are ranked by value id (the original's top-K cut fell among tied
candidates in set-iteration order, so two runs of the same data could select
different parameters). One addition: Grambank can be looked up under its own name
(the original used the WALS name for both).
"""

from __future__ import annotations

import random
from dataclasses import asdict, dataclass
from typing import Any

from ..legacy import cq_observers as obs
from ..legacy import ga_param_selection_utils as psu
from ..legacy import general_agents
from ..reference import bridge as gwu
from ..reference import catalog
from ..reference import grambank as gu
from ..reference import wals as wu
from ..reference.paths import reference_dir
from ..reference.util import load_json

# The observers dig4el activates, keyed by the parameter each one observes.
# The boolean is the observer's `canonical` flag (restrict to assertive,
# positive-polarity sentences).
OBSERVED_PARAMS: dict[str, tuple] = {
    "Order of Subject, Object and Verb": (obs.observer_order_of_subject_object_verb, True),
    "Order of Subject and Verb": (obs.observer_order_of_subject_and_verb, True),
    "Order of Adjective and Noun": (obs.observer_order_of_adjective_and_noun, False),
    "Order of Demonstrative and Noun": (obs.observer_order_of_demonstrative_and_noun, False),
    "Order of Relative Clause and Noun": (obs.observer_order_of_relative_clause_and_noun, False),
    "Is there a male/female distinction in 1st person independent pronouns?": (
        obs.observer_free_pp1_gender, False),
    "Is there a male/female distinction in 2nd person independent pronouns?": (
        obs.observer_free_pp2_gender, False),
    "Is there a gender distinction in independent 3rd person pronouns?": (
        obs.observer_free_pp3_gender, False),
    "Are there morphological cases for pronominal core arguments (i.e. S/A/P)?": (
        obs.observer_free_pp1sg_semantic_role, False),
    "Inclusive/Exclusive Distinction in Independent Pronouns": (
        obs.observer_free_pp_inclusive_exclusive, False),
}


@dataclass
class Settings:
    """The pipeline's thresholds, named as in the dissertation where it names them."""

    cp_min: float = 0.8  # ECP: minimum edge weight followed during frontier expansion
    belief_min: float = 0.8  # Pstrong: belief above which a value seeds the frontier
    depth: int = 5  # d: breadth-first depth limit
    score_min: float = 0.85  # Pscore: minimum utility score for a proposed candidate
    top_k: int = 300  # K: most candidates returned
    strong_seed_report: float = 0.9  # the seed count the page reports
    messaging_cycles: int = 3  # independent propagation runs from the same snapshot
    rounds_per_cycle: int = 3  # message rounds per run
    confidence_min: float = 0.8  # a parameter is reported when 1 - entropy exceeds this
    seed: int | None = None  # random seed for the traversal order; None = unseeded


@dataclass
class Known:
    wals_language_pk: str | None
    grambank_language_id: str | None
    wals: dict[str, dict[str, str]]  # parameter name -> {value, code}
    grambank: dict[str, dict[str, str]]

    @property
    def wals_codes(self) -> dict[str, str]:
        return {p: v["code"] for p, v in self.wals.items()}

    @property
    def grambank_codes(self) -> dict[str, str]:
        return {p: v["code"] for p, v in self.grambank.items()}


_cpt_graph = None


def cpt_graph():
    """The value-to-value conditional-probability graph over WALS and Grambank, loaded once."""
    global _cpt_graph
    if _cpt_graph is None:
        _cpt_graph = psu.load_all_cpts(reference_dir())
    return _cpt_graph


def params_by_topic() -> dict[str, list[str]]:
    return load_json(reference_dir() / "params_by_topic.json")


def known_values(language_name: str, grambank_name: str | None = None) -> Known:
    """What WALS and Grambank document for the language. ``language_name`` is the WALS
    name; Grambank is looked up by ``grambank_name`` when given, else by the same name
    (the original's single-name behavior)."""
    wals_pk = wu.language_pk_for_name(language_name)
    gb_id = gu.language_id_for_name(grambank_name or language_name)
    return Known(
        wals_language_pk=wals_pk,
        grambank_language_id=gb_id,
        wals=wu.known_values_for_language_pk(wals_pk) if wals_pk else {},
        grambank=gu.known_values_for_language_id(gb_id) if gb_id else {},
    )


def run_observers(kg: dict, language_name: str, delimiters: list[str]) -> dict[str, dict]:
    """Every observer's full output, keyed by parameter name."""
    out: dict[str, dict] = {}
    for pname, (func, canonical) in OBSERVED_PARAMS.items():
        out[pname] = func(kg, language_name, delimiters, canonical=canonical)
    return out


def observed_counts(observer_outputs: dict[str, dict]) -> dict[str, dict[str, int]]:
    """The agent-ready count vectors: parameter name -> {value code: count}."""
    return {p: o["agent-ready observation"] for p, o in observer_outputs.items()}


def discover_parameters(counts: dict[str, dict[str, int]], known: Known, settings: Settings) -> dict:
    """Frontier discovery: which parameters the observed and known values reach."""
    G = cpt_graph()
    belief = psu.BeliefState({v: 1 / G.number_of_nodes() for v in G.nodes})

    selection_agent = general_agents.GeneralAgent(
        "parameter_selection_ga", parameter_names=list(counts.keys()), language_stat_filter={}
    )
    for pname, c in counts.items():
        selection_agent.add_observations(pname, c)
    selection_agent.run_belief_update_from_observations()
    for lp in selection_agent.language_parameters.values():
        for v_code, proba in lp.beliefs.items():
            belief.update_observation(v_code, proba)
    for code in known.wals_codes.values():
        belief.set_known(code)
    for code in known.grambank_codes.values():
        belief.set_known(code)

    strong_seeds = set(belief.strong_values(settings.strong_seed_report))
    suggested = psu.suggest_parameters(
        G, belief,
        θ_CP=settings.cp_min, θ_belief=settings.belief_min, d=settings.depth,
        θ_score=settings.score_min, K=settings.top_k,
    )
    # dig4el drops negation parameters here (its TODO notes they leak through the filters).
    selected = [
        (vid, score) for vid, score in suggested
        if "neg" not in gwu.get_pname_from_value_code(vid) and "Neg" not in gwu.get_pname_from_value_code(vid)
    ]
    available = {gwu.get_pname_from_value_code(vid) for vid, _ in selected}
    available |= {gwu.get_pname_from_value_code(vid) for vid in strong_seeds}

    by_topic = {
        topic: [p for p in plist if p in available] for topic, plist in params_by_topic().items()
    }
    agent_params: list[str] = []
    for plist in by_topic.values():
        for p in plist:
            if p not in agent_params:
                agent_params.append(p)
    return {
        "strong_seeds": sorted(strong_seeds),
        "selected": selected,
        "by_topic": by_topic,
        "agent_parameters": agent_params,
        "observation_beliefs": {
            p: dict(lp.beliefs) for p, lp in selection_agent.language_parameters.items()
        },
    }


def run_agent(agent_params: list[str], counts: dict[str, dict[str, int]], known: Known,
              settings: Settings, language_stat_filter: dict | None = None):
    """Build the agent, apply observations and known values, propagate. Returns the agent
    and the consensus store (final beliefs of each propagation run)."""
    if settings.seed is not None:
        random.seed(settings.seed)
    ga = general_agents.GeneralAgent(
        "ga", parameter_names=list(agent_params), language_stat_filter=language_stat_filter or {}
    )
    for pname, c in counts.items():
        ga.add_observations(pname, c)
    ga.run_belief_update_from_observations()
    for pname in counts:
        lp = ga.language_parameters.get(pname)
        if lp is not None:
            lp.update_entropy()
            lp.update_weight_from_observations()
    for pname, code in known.wals_codes.items():
        if pname in ga.language_parameters:
            ga.language_parameters[pname].inject_peak_belief(code, 1, locked=True)
    for pname, code in known.grambank_codes.items():
        if pname in ga.language_parameters:
            ga.language_parameters[pname].inject_peak_belief(code, 1, locked=True)

    snapshot = ga.get_beliefs()
    consensus: dict[int, dict] = {}
    for k in range(settings.messaging_cycles):
        ga.reset_beliefs_history()
        ga.put_beliefs(snapshot)
        for _ in range(settings.rounds_per_cycle):
            ga.run_belief_update_cycle()
        consensus[k] = ga.get_beliefs()
    return ga, consensus


def origin_of(pname: str, counts: dict, known: Known) -> str:
    if pname in known.wals or pname in known.grambank:
        return "known"
    if pname in counts:
        return "observed"
    return "inferred"


def summarize_parameters(ga, counts: dict, known: Known, settings: Settings) -> list[dict]:
    rows = []
    for pname, lp in ga.language_parameters.items():
        confidence = float(1 - lp.entropy)
        winner = lp.get_winning_belief_code()
        rows.append(
            {
                "parameter": pname,
                "origin": origin_of(pname, counts, known),
                "database": "grambank" if pname in gu.grambank_pid_by_pname else "wals",
                "winner_code": winner,
                "winner": gwu.get_pvalue_name_from_value_code(winner),
                "confidence": int(round(100 * confidence)),
                "retained": bool(confidence > settings.confidence_min),
                "locked": bool(lp.locked),
                "beliefs": {
                    code: {"name": gwu.get_pvalue_name_from_value_code(code), "p": float(p)}
                    for code, p in lp.beliefs.items()
                },
            }
        )
    rows.sort(key=lambda r: (-r["confidence"], r["parameter"]))
    return rows


def observation_evidence(observer_outputs: dict[str, dict], kg: dict) -> dict[str, dict]:
    """Per observed parameter, the counts per value and the sentences behind them."""
    out: dict[str, dict] = {}
    for pname, o in observer_outputs.items():
        values = {}
        for vname, det in o["observations"].items():
            examples = []
            for entry_index, signature in det["details"].items():
                e = kg.get(entry_index) if entry_index in kg else kg.get(int(entry_index))
                if e is None:
                    continue
                examples.append(
                    {
                        "entry": entry_index,
                        "prompt": e["sentence_data"]["text"],
                        "translation": e["recording_data"]["translation"],
                        "signature": signature,
                    }
                )
            values[vname] = {"code": det["depk"], "count": det["count"], "examples": examples}
        out[pname] = {"parameter_code": o.get("ppk"), "values": values}
    return out


def run_inference(kg: dict, language_name: str, delimiters: list[str] | None = None,
                  settings: Settings | None = None, grambank_name: str | None = None) -> dict[str, Any]:
    """The whole pipeline. Returns a JSON-serializable report."""
    settings = settings or Settings()
    delimiters = delimiters or catalog.delimiters_for(language_name)
    known = known_values(language_name, grambank_name)
    outputs = run_observers(kg, language_name, delimiters)
    counts = observed_counts(outputs)
    discovery = discover_parameters(counts, known, settings)
    ga, consensus = run_agent(discovery["agent_parameters"], counts, known, settings)
    parameters = summarize_parameters(ga, counts, known, settings)
    return {
        "language": language_name,
        "grambank_name": grambank_name or language_name,
        "delimiters": delimiters,
        "settings": asdict(settings),
        "known": {
            "wals_language_pk": known.wals_language_pk,
            "grambank_language_id": known.grambank_language_id,
            "wals": known.wals,
            "grambank": known.grambank,
        },
        "observations": {"counts": counts, "evidence": observation_evidence(outputs, kg)},
        "discovery": {
            "strong_seeds": discovery["strong_seeds"],
            "selected": discovery["selected"],
            "by_topic": discovery["by_topic"],
            "agent_parameters": discovery["agent_parameters"],
        },
        "parameters": parameters,
        "consensus": {
            str(k): {p: {c: float(x) for c, x in b.items()} for p, b in v.items()}
            for k, v in consensus.items()
        },
    }
