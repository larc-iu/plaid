"""
Legend of symbols used in the comments
--------------------------------------
•  P(t | s)  – conditional probability from the CPT JSON files.
•  b_v       – current belief that value v is true for the target language.
•  θ_belief  – threshold above which a value is considered *strong*.
•  θ_CP      – floor on edge weights kept during frontier expansion.
•  θ_score   – minimum score for a candidate to be proposed.
•  d         – Breadth-first frontier (BFS) depth limit.
•  K         – top‑k suggestions to return.
"""

import json
import math
from pathlib import Path
from typing import Dict, Tuple, List, Set

import networkx as nx

###############################################################################
# 1.  Loading CPTs → weighted directed graph
###############################################################################


def _safe_float(x):
    """Return float(x) or None if x is null / non‑numeric / NaN."""
    try:
        f = float(x)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def load_cpt(path: Path) -> Dict[Tuple[str, str], float]:
    """Flatten one CPT JSON file into {(src_value, tgt_value): P(tgt|src)}."""
    with open(path, "r", encoding="utf-8") as fp:
        raw: Dict[str, Dict[str, float]] = json.load(fp)

    edges: Dict[Tuple[str, str], float] = {}
    for src, row in raw.items():
        if not src:
            continue  # skip blank source ids
        for tgt, prob in row.items():
            if src == tgt:  # skip diagonal
                continue
            if not tgt:
                continue
            p = _safe_float(prob)
            if p is None:
                continue  # ignore ill‑formed entries
            # Edge weight = P(tgt | src)
            edges[(src, tgt)] = p
    return edges


def load_all_cpts(base_dir: Path) -> nx.DiGraph:
    """Return a DiGraph whose edges carry the CPT probabilities as weights."""
    filenames = [
        "wals_derived/de_conditional_probability_df.json",          # WALS → WALS
        "grambank_derived/grambank_vid_conditional_probability.json",   # GB   → GB
        "grambank_given_wals_cpt.json",                # WALS → GB
        "wals_given_grambank_cpt.json",                # GB   → WALS
    ]

    G = nx.DiGraph()
    for fname in filenames:
        path = base_dir / fname
        if not path.exists():
            print(f"[WARN] missing CPT: {path}")
            continue
        for (src, tgt), p in load_cpt(path).items():
            G.add_edge(src, tgt, weight=p)
    return G

###############################################################################
# 2.  Belief vector  b_v   (priors → observations → known values)
###############################################################################

class BeliefState:
    """Holds the current subjective probability for every value id."""

    def __init__(self, priors: Dict[str, float]):
        # Vector  b  over all vertices; starts with family priors.
        self.belief = priors.copy()

    # ────────────────────────────────────────────────────────────────────
    # Bayesian update hooks: observation vs. known
    # ────────────────────────────────────────────────────────────────────

    def update_observation(self, value_id: str, p: float):
        """Soft evidence: 0 < p < 1."""
        self.belief[value_id] = p

    def set_known(self, value_id: str):
        """Hard evidence: probability 1 for the chosen value, 0 for its siblings."""
        param = value_id.split("-")[0]  # works for GB###‑x and plain WALS numbers
        for vid in list(self.belief.keys()):
            if vid.split("-")[0] == param:
                self.belief[vid] = 1.0 if vid == value_id else 0.0

    # Convenience --------------------------------------------------------

    def strong_values(self, θ_belief: float = 0.7) -> List[str]:
        """Return every value whose current belief ≥ θ_belief."""
        return [v for v, p in self.belief.items() if p >= θ_belief]

###############################################################################
# 3.  Frontier expansion   (graph search restricted by θ_CP)
###############################################################################


def expand_frontier(
    G: nx.DiGraph,
    seeds: Set[str],
    θ_CP: float = 0.3, # floor on edge weights kept during frontier expansion.
    d: int = 2, # BFS depth limit
) -> Set[str]:
    """Breadth‑first out to depth *d*, keeping only edges with weight ≥ θ_CP."""
    frontier = set(seeds)
    reached = set(seeds)
    for _ in range(d):
        nxt = {
            v
            for u in frontier
            for v, attrs in G[u].items()
            if attrs["weight"] >= θ_CP and v not in reached
        }
        if not nxt:
            break
        reached.update(nxt)
        frontier = nxt
    # candidates = nodes we discovered minus the original strong seeds
    return reached - seeds

###############################################################################
# 4.  Scoring candidates   s_c = max_p   P(c|p) · b_p
###############################################################################


def score_candidates(
    G: nx.DiGraph,
    belief: BeliefState,
    cand: Set[str],
) -> List[Tuple[str, float]]:
    scores = {}
    for c in cand:
        # For every predecessor p → c compute the product
        #   local conditional × current belief of p
        best = max(
            (G[p][c]["weight"] * belief.belief.get(p, 0.0) for p in G.predecessors(c)),
            default=0.0,
        )
        scores[c] = best  # heuristic of expected info gain
    # Deterministic ranking: ties broken by value id. The original sorted by score
    # alone over a set, so which tied candidates made the top-K depended on set
    # iteration order and differed from one process to the next.
    return sorted(scores.items(), key=lambda t: (-t[1], t[0]))

###############################################################################
# 5.  Putting it together   suggest_parameters()
###############################################################################


def suggest_parameters(
    G: nx.DiGraph,
    belief: BeliefState,
    θ_CP: float = 0.3,  # floor on edge weights kept during frontier expansion
    θ_belief: float = 0.7,  # threshold above which a value is considered *strong*
    d: int = 2,  # BFS depth limit
    θ_score: float = 0.2,  # minimum score for a candidate to be proposed
    K: int = 20  # top‑k suggestions to return.
) -> List[Tuple[str, float]]:
    """Return up to *K* value‑IDs ranked by heuristic information gain."""
    strong = set(belief.strong_values(θ_belief))
    if not strong:
        return []

    cand = expand_frontier(G, strong, θ_CP, d)
    ranked = score_candidates(G, belief, cand)
    # Filter low utility suggestions
    return [(vid, s) for vid, s in ranked if s >= θ_score][:K]

