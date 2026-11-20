"""The sentences of the project most like a piece's, as people analysed them:
whole analysed sentences that show how word forms of the same shape were
segmented, and the morpheme and word fields a job fills filled. Pure
functions, no model, fixed rules.

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
#: The line under it naming the items' columns, when they are not
#: analyze_sentence's default.
COLUMNS_LINE = 'Columns of the words: '


def pick(pool: Pool, queries: Sequence[frozenset], k: int = JOB_SIMILAR_SENTENCES,
         skip: frozenset = frozenset()) -> List[int]:
    """A piece's list (the shared rule's :func:`pick`), ``k`` the job's
    number by default."""
    return _pick(pool, queries, k, skip)


def word_item(analysis: Dict[str, Any], fields: Sequence[str] = ()) -> str:
    """A word's analysis as analyze_sentence takes it: its morphemes' forms
    joined by "-", or "=" at a clitic boundary, then for each of ``fields``
    (morpheme field names) one space and that field's values joined the
    same way, "_" for a morpheme with none. A value is shown as it is
    written, a space or a delimiter in it too."""
    ms = analysis.get('morphemes') or []

    def joined(parts):
        return ''.join(('' if i == 0 else '=' if m.get('equals') else '-') + p
                       for i, (m, p) in enumerate(zip(ms, parts)))
    return ' '.join([joined([m.get('form') or '_' for m in ms])]
                    + [joined([(m.get('fields') or {}).get(f) or '_' for m in ms]) for f in fields])


def lines_of(example: Dict[str, Any], fields: Sequence[str] = (), word_fields: Sequence[str] = ()) -> str:
    """One pool sentence as the block shows it: its text, its translation
    when it has one, its words (analyses) as analyze_sentence's ``words``
    takes them (:func:`word_item` of ``fields``), then for each of
    ``word_fields`` (word field names) a line of its name and its value on
    each word in order, "_" for a word with none."""
    out = [example['text']]
    if example.get('translation'):
        out.append(f'Translation: {example["translation"]}')
    out.append('Words: ' + json.dumps([word_item(a, fields) for a in example['words']], ensure_ascii=False))
    out += [f'{f}: ' + json.dumps([(a.get('word') or {}).get(f) or '_' for a in example['words']], ensure_ascii=False)
            for f in word_fields]
    return '\n'.join(out)


def block(examples: Sequence[Dict[str, Any]], fields: Sequence[str] = (), columns: Optional[Sequence[str]] = None,
          budget: int = JOB_SIMILAR_CHARS, word_fields: Sequence[str] = ()) -> str:
    """The block of ``examples`` in the order taken (the most alike first),
    shown the most alike last, each word with its forms and ``fields``, a
    line under the words for each of ``word_fields``, and under the head the
    items' ``columns`` (as analyze_sentence's ``columns`` names them) when
    given, within ``budget`` characters: what does not fit is dropped from
    the last taken. Empty when none fits."""
    head = HEAD if columns is None else HEAD + '\n' + COLUMNS_LINE + json.dumps(list(columns), ensure_ascii=False)
    shown = [lines_of(x, fields, word_fields) for x in examples]
    while shown and len(head) + sum(len(x) + 2 for x in shown) > budget:
        shown.pop()
    return '\n\n'.join([head] + shown[::-1]) if shown else ''
