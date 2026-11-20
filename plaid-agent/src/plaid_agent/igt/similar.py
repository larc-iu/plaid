"""The sentences of the project most like a piece's, as people analysed them
(BRIEF-SS, 2026-11-20): whole analysed sentences that show how word forms of
the same shape were segmented and glossed. Pure functions, no model, fixed
rules, the rule of the evaluation's plain-prompt baseline (fair/plain.py,
``feats`` and ``Lang.nearest``).

- A sentence's features are its words (their form keys, ``evidence.form_of``:
  casefolded, the edge punctuation trimmed, punctuation never a word), and the
  character 3-grams and 4-grams of each word written ``^word$``.
- A feature's weight is ``log(N / df)`` over the pool (N pool sentences, df
  those holding it). The similarity of a pool sentence to a sentence is the
  sum of the squared weights of the features they share over the pool
  sentence's norm (the square root of the sum of its squared weights).
- A piece's list (:func:`pick`): each of its sentences ranks the pool, the
  most alike first, a tie by the pool's order (document order). The lists
  are taken round robin (every sentence's nearest, then every sentence's
  second, and so on, a pool sentence once) until ``k`` are taken. That order
  is the order of similarity: the block shows the last taken first and the
  first taken last, and its budget drops from the last taken.
"""

import heapq
import json
import math
from typing import Any, Dict, Iterable, List, Optional, Sequence

from ..core.limits import JOB_SIMILAR_CHARS, JOB_SIMILAR_SENTENCES

#: The block's head line, as the model reads it.
HEAD = 'Sentences of this project most like these, as people analysed them, the most alike last:'


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


def pick(pool: Pool, queries: Sequence[frozenset], k: int = JOB_SIMILAR_SENTENCES,
         skip: frozenset = frozenset()) -> List[int]:
    """A piece's list, in the order taken (the most alike first): each
    query's ranking taken round robin, a pool sentence once, ``k`` at most,
    never one in ``skip``."""
    lists = [pool.ranked(q, k, skip) for q in queries]
    taken: List[int] = []
    seen = set()
    for r in range(k):
        for ranks in lists:
            if r < len(ranks) and ranks[r] not in seen and len(taken) < k:
                seen.add(ranks[r])
                taken.append(ranks[r])
    return taken


def word_item(analysis: Dict[str, Any], gloss: Optional[str]) -> str:
    """A word's analysis as analyze_sentence takes it, "FORMS GLOSS": its
    morphemes' forms joined by "-", or "=" at a clitic boundary, one space,
    their glosses joined the same way, "_" for a morpheme with none (forms
    alone in a project with no gloss field)."""
    ms = analysis.get('morphemes') or []

    def joined(parts):
        return ''.join(('' if i == 0 else '=' if m.get('equals') else '-') + p
                       for i, (m, p) in enumerate(zip(ms, parts)))
    forms = joined([m.get('form') or '_' for m in ms])
    if gloss is None:
        return forms
    return forms + ' ' + joined([(m.get('fields') or {}).get(gloss) or '_' for m in ms])


def lines_of(example: Dict[str, Any]) -> str:
    """One pool sentence as the block shows it: its text, its translation
    when it has one, and its words as analyze_sentence's ``words`` takes
    them."""
    out = [example['text']]
    if example.get('translation'):
        out.append(f'Translation: {example["translation"]}')
    out.append('Words: ' + json.dumps(example['words'], ensure_ascii=False))
    return '\n'.join(out)


def block(examples: Sequence[Dict[str, Any]], budget: int = JOB_SIMILAR_CHARS) -> str:
    """The block of ``examples`` in the order taken (the most alike first),
    shown the most alike last, within ``budget`` characters: what does not
    fit is dropped from the last taken. Empty when none fits."""
    shown = [lines_of(x) for x in examples]
    while shown and len(HEAD) + sum(len(x) + 2 for x in shown) > budget:
        shown.pop()
    return '\n\n'.join([HEAD] + shown[::-1]) if shown else ''
