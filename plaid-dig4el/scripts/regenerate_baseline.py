"""Regenerate a parity baseline with dig4el's ORIGINAL code.

Run from the root of a dig4el clone (https://github.com/alterfero/dig4el) with an
environment that has its requirements (the `dig4el` mamba env on Luke's machine):

    cd dig4el && python /path/to/regenerate_baseline.py 0 Tahitian \
        /path/to/plaid-dig4el/tests/fixtures/tahitian_current_kg.json \
        /path/to/plaid-dig4el/tests/fixtures/baseline_tahitian_seed0.json

Arguments: seed, language name (as WALS/Grambank name it), knowledge-graph JSON,
output path. Mirrors pages/infer_from_knowledge_and_cqs.py, with the one
deterministic tie-break the port also applies (see legacy/ga_param_selection_utils.py).
Minify the output before committing it as a fixture.
"""
import json, os, random, sys
from pathlib import Path

os.makedirs("ld/storage", exist_ok=True)
if not os.path.exists("ld/storage/languages.json"):
    json.dump({"Tahitian": "tahi1242"}, open("ld/storage/languages.json", "w"))
sys.path.insert(0, ".")
from libs import cq_observers as obs, general_agents, ga_param_selection_utils as psu
from libs import wals_utils as wu, grambank_utils as gu, grambank_wals_utils as gwu

# Deterministic tie-break at the top-K cut (see plaid_dig4el.legacy.ga_param_selection_utils).
def _score_candidates(G, belief, cand):
    scores = {}
    for c in cand:
        best = max((G[p][c]["weight"] * belief.belief.get(p, 0.0) for p in G.predecessors(c)), default=0.0)
        scores[c] = best
    return sorted(scores.items(), key=lambda t: (-t[1], t[0]))
psu.score_candidates = _score_candidates

SEED = int(sys.argv[1]) if len(sys.argv) > 1 else 0
language = sys.argv[2] if len(sys.argv)>2 else "Tahitian"
kg = {int(k): v for k, v in json.load(open(sys.argv[3] if len(sys.argv)>3 else "data/knowledge/current_kg.json", encoding="utf-8")).items()}
delimiters = json.load(open("data/delimiters.json", encoding="utf-8")).get(language, [" ", ".", ",", ";", ":", "!", "?", "…"])

observed_params = {
    "Order of Subject, Object and Verb": (obs.observer_order_of_subject_object_verb, True),
    "Order of Subject and Verb": (obs.observer_order_of_subject_and_verb, True),
    "Order of Adjective and Noun": (obs.observer_order_of_adjective_and_noun, False),
    "Order of Demonstrative and Noun": (obs.observer_order_of_demonstrative_and_noun, False),
    "Order of Relative Clause and Noun": (obs.observer_order_of_relative_clause_and_noun, False),
    "Is there a male/female distinction in 1st person independent pronouns?": (obs.observer_free_pp1_gender, False),
    "Is there a male/female distinction in 2nd person independent pronouns?": (obs.observer_free_pp2_gender, False),
    "Is there a gender distinction in independent 3rd person pronouns?": (obs.observer_free_pp3_gender, False),
    "Are there morphological cases for pronominal core arguments (i.e. S/A/P)?": (obs.observer_free_pp1sg_semantic_role, False),
    "Inclusive/Exclusive Distinction in Independent Pronouns": (obs.observer_free_pp_inclusive_exclusive, False),
}
obs_out, observed = {}, {}
for name, (func, canonical) in observed_params.items():
    obs_out[name] = func(kg, language, delimiters, canonical=canonical)
    observed[name] = obs_out[name]["agent-ready observation"]

tl_wals_pk = wu.language_pk_id_by_name.get(language, {}).get("pk")
known_wals_pk = {}
if tl_wals_pk is not None and tl_wals_pk in wu.domain_elements_by_language:
    for kv in wu.domain_elements_by_language[tl_wals_pk]:
        known_wals_pk[wu.parameter_name_by_pk[wu.param_pk_by_de_pk[str(kv)]]] = str(kv)
lid = next((l for l, v in gu.grambank_language_by_lid.items() if v["name"] == language), None)
ginfo = gu.get_grambank_language_data_by_id_or_name(lid) if lid else {}
known_grambank_pid = {gu.grambank_pname_by_pid[p]: ginfo[p]["vid"] for p in ginfo}

G = psu.load_all_cpts(Path("./external_data"))
belief = psu.BeliefState({v: 1 / G.number_of_nodes() for v in G.nodes})
psga = general_agents.GeneralAgent("parameter_selection_ga", parameter_names=list(obs_out.keys()), language_stat_filter={})
for n in observed:
    psga.add_observations(n, observed[n])
psga.run_belief_update_from_observations()
for p in psga.language_parameters:
    for v, proba in psga.language_parameters[p].beliefs.items():
        belief.update_observation(v, proba)
for v in known_wals_pk.values():
    belief.set_known(v)
for v in known_grambank_pid.values():
    belief.set_known(v)
strong = set(belief.strong_values(0.9))
sel = psu.suggest_parameters(G, belief, θ_CP=0.8, θ_belief=0.8, d=5, θ_score=0.85, K=300)
sel = [tp for tp in sel if "neg" not in gwu.get_pname_from_value_code(tp[0]) and "Neg" not in gwu.get_pname_from_value_code(tp[0])]
available = [gwu.get_pname_from_value_code(c[0]) for c in sel] + [gwu.get_pname_from_value_code(c) for c in strong]
pbt = json.load(open("external_data/params_by_topic.json", encoding="utf-8"))
by_topic = {t: [p for p in ps if p in available] for t, ps in pbt.items()}
ga_names = []
for t in by_topic:
    for p in by_topic[t]:
        if p not in ga_names:
            ga_names.append(p)

random.seed(SEED)
ga = general_agents.GeneralAgent("ga", parameter_names=ga_names, language_stat_filter={})
for n in observed:
    ga.add_observations(n, observed[n])
ga.run_belief_update_from_observations()
for n in observed:
    if n in ga.language_parameters:
        ga.language_parameters[n].update_entropy()
        ga.language_parameters[n].update_weight_from_observations()
for p, depk in known_wals_pk.items():
    if p in ga.language_parameters:
        ga.language_parameters[p].inject_peak_belief(depk, 1, locked=True)
for p, vid in known_grambank_pid.items():
    if p in ga.language_parameters:
        ga.language_parameters[p].inject_peak_belief(vid, 1, locked=True)
snapshot = ga.get_beliefs()
consensus = {}
for k in range(3):
    ga.reset_beliefs_history()
    ga.put_beliefs(snapshot)
    for i in range(3):
        ga.run_belief_update_cycle()
    consensus[k] = ga.get_beliefs()

results = {}
for p, P in ga.language_parameters.items():
    origin = "known" if (p in known_wals_pk or p in known_grambank_pid) else ("observed" if p in observed else "inferred")
    results[p] = {"origin": origin, "winner": P.get_winning_belief_code(), "confidence": round(100 * (1 - P.entropy)),
                  "beliefs": P.beliefs, "locked": P.locked}
out = {"observed": observed, "known_wals_pk": known_wals_pk, "known_grambank_pid": known_grambank_pid,
       "strong": sorted(strong), "selected": sel, "ga_names": ga_names, "results": results}
json.dump(out, open((sys.argv[4] if len(sys.argv)>4 else f"../baseline_tahitian_seed{SEED}.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print("params in agent:", len(ga_names), "strong seeds:", len(strong), "selected:", len(sel))
print("known wals:", len(known_wals_pk), "known grambank:", len(known_grambank_pid))
for n in observed:
    print(" obs", n, observed[n])
