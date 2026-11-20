"""The analysed sentences of a project most like a sentence: the one rule an
assistant job and the LLM glossing service pick their examples by. Pure
functions, no model, fixed rules. How the examples are shown is the caller's.

- A sentence's features are its words (their form keys, as the caller keys
  them, an empty key no word) and the character 3-grams and 4-grams of each
  word written ``^word$``.
- A feature's weight is ``log(N / df)`` over the pool (N pool sentences, df
  those holding it). The similarity of a pool sentence to a sentence is the
  sum of the squared weights of the features they share over the pool
  sentence's norm (the square root of the sum of its squared weights).
- A list for several sentences (:func:`pick`): each of them ranks the pool,
  the most alike first, a tie by the pool's order. The lists are taken round
  robin (every sentence's nearest, then every sentence's second, and so on, a
  pool sentence once) until ``k`` are taken, the most alike first.
"""

import heapq
import math
from typing import Dict, Iterable, List, Sequence


def features(words: Iterable[str]) -> frozenset:
    """A sentence's features, from its words' form keys (empty ones are no
    word)."""
    out = set()
    for w in words:
        if not w:
            continue
        out.add(w)
        p = f'^{w}$'
        for n in (3, 4):
            out.update(p[i:i + n] for i in range(len(p) - n + 1))
    return frozenset(out)


class Pool:
    """The weights of a pool of sentences' features (``feats``, in the
    pool's order), computed once, with each feature's sentences."""

    def __init__(self, feats: Sequence[frozenset]):
        self.feats = list(feats)
        self.holding: Dict[str, List[int]] = {}
        for i, fs in enumerate(self.feats):
            for f in fs:
                self.holding.setdefault(f, []).append(i)
        n = len(self.feats)
        self.w2 = {f: math.log(n / len(ids)) ** 2 for f, ids in self.holding.items()}
        self.norm = [math.sqrt(sum(self.w2[f] for f in fs)) or 1.0 for fs in self.feats]

    def ranked(self, query: frozenset, k: int, skip: frozenset = frozenset()) -> List[int]:
        """The ``k`` pool sentences most like ``query``, the most alike
        first, a tie by the pool's order, never one in ``skip``: those
        sharing a feature with it by score, then the others in order. The
        features are summed in one order and a score rounded, so the order
        never hangs on the order a sum was taken in."""
        shared: Dict[int, float] = {}
        for f in sorted(query):
            w = self.w2.get(f)
            if w:
                for i in self.holding[f]:
                    shared[i] = shared.get(i, 0.0) + w
        scored = [(-round(v / self.norm[i], 9), i) for i, v in shared.items() if i not in skip]
        out = [i for _, i in heapq.nsmallest(k, scored)]
        for i in range(len(self.feats)):
            if len(out) >= k:
                break
            if i not in shared and i not in skip:
                out.append(i)
        return out


def pick(pool: Pool, queries: Sequence[frozenset], k: int, skip: frozenset = frozenset()) -> List[int]:
    """The list for ``queries``, in the order taken (the most alike first):
    each query's ranking taken round robin, a pool sentence once, ``k`` at
    most, never one in ``skip``."""
    lists = [pool.ranked(q, k, skip) for q in queries]
    taken: List[int] = []
    seen = set()
    for r in range(k):
        for ranks in lists:
            if r < len(ranks) and ranks[r] not in seen and len(taken) < k:
                seen.add(ranks[r])
                taken.append(ranks[r])
    return taken
