"""The sentences of the project most like a piece's, as people analysed them:
whole analysed sentences that show how word forms of the same shape were
segmented and glossed. Pure functions, no model, fixed rules.

- The rule is ``plaid_client.workflows.igt.similar`` (:func:`features`,
  :class:`Pool`, :func:`pick`), the one the LLM glossing service picks its
  examples by too. A word's form key is ``evidence.form_of`` (casefolded, the
  edge punctuation trimmed, punctuation never a word).
- A piece's list (:func:`pick`): each of its sentences ranks the pool, the
  most alike first, a tie by the pool's order (document order), taken round
  robin until ``k`` are taken. That order is the order of similarity: the
  block shows the last taken first and the first taken last, and its budget
  drops from the last taken.
"""

import json
from typing import Any, Dict, List, Optional, Sequence

from plaid_client.workflows.igt.similar import Pool, features  # noqa: F401 (the job reads them here)
from plaid_client.workflows.igt.similar import pick as _pick

from ..core.limits import JOB_SIMILAR_CHARS, JOB_SIMILAR_SENTENCES

#: The block's head line, as the model reads it.
HEAD = 'Sentences of this project most like these, as people analysed them, the most alike last:'


def pick(pool: Pool, queries: Sequence[frozenset], k: int = JOB_SIMILAR_SENTENCES,
         skip: frozenset = frozenset()) -> List[int]:
    """A piece's list (the shared rule's :func:`pick`), ``k`` the job's
    number by default."""
    return _pick(pool, queries, k, skip)


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
