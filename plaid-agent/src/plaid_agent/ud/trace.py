"""UD's words for its own tools, for the trace next to a reply.

The counting, the summary line and the item shape are in
:mod:`plaid_agent.core.trace`. What a call DID is here, next to the tool table
in :mod:`.tools`, so a new tool is described where it is declared. A tool with
no line of its own falls back to its name, and ``tests/test_ud_trace.py`` fails
if any declared tool reaches that fallback.
"""

import re
from typing import Any, Dict, List, Optional

from ..core.scope import is_all
from ..core.trace import count, in_doc, plural, q, tracer_for
from .toolkit import WEB_TOOLS, WRITE_TOOLS


def _named(docs: Any) -> List[str]:
    """The documents a ``documents`` argument names, each once: a name given
    twice, or in another case, is one document to the read (core/scope.py)."""
    docs = [docs] if isinstance(docs, str) else list(docs) if isinstance(docs, list) else []
    out: Dict[str, str] = {}
    for d in docs:
        out.setdefault(str(d).strip().casefold(), str(d).strip())
    return list(out.values())


def in_docs(a: Dict[str, Any]) -> str:
    """For a read: ' in "<document>"', ' in 3 documents' when it is held to
    several (core/scope.py), or nothing when it was project-wide."""
    docs = _named(a.get('documents'))
    if docs and not a.get('document'):
        return f' in {q(docs[0])}' if len(docs) == 1 else f' in {plural(len(docs), "document")}'
    return in_doc(a)


def across(a: Dict[str, Any]) -> str:
    """The documents a review covers when ``documents`` names them: the
    one, how many, or every document waiting for "all" (core.scope.is_all,
    the only word that means the project)."""
    docs = a.get('documents')
    if not docs or a.get('document'):
        return ''
    if is_all(docs):
        return ' across every document with something waiting'
    named = _named(docs)
    if len(named) == 1:
        return f' in {q(named[0])}'
    return f' across {plural(len(named), "document")}'


# What frequency_list ranks, in the plural ("Ranked UPOS tags").
_RANKED = {'lemma': 'lemmas', 'form': 'forms', 'upos': 'UPOS tags', 'xpos': 'XPOS tags',
           'deprel': 'deprels', 'features': 'features', 'feature-bundles': 'feature bundles'}


def _ngram(a: Dict[str, Any]) -> Optional[int]:
    """frequency_list's ``ngram`` as the tool reads it (``"2"`` is 2), when
    it asks for runs of words."""
    try:
        n = int(str(a.get('ngram')).strip())
    except ValueError:
        return None
    return n if n > 1 else None


def _forms(a: Dict[str, Any]) -> List[str]:
    forms = a.get('forms') or []
    if isinstance(forms, str):
        forms = [forms]
    return [f.strip() for f in forms if isinstance(f, str) and f.strip()]


def _respells(a: Dict[str, Any]) -> bool:
    """Whether set_words gives the token as many forms as its reference has
    words (``s1.w2-3`` two, ``s1.w4`` one), which respells them in place
    rather than reshaping the token (see ``shape.t_set_words``)."""
    m = re.search(r'w(\d+)(?:-(\d+))?$', str(a.get('ref') or ''))
    if not m:
        return False
    first, last = int(m.group(1)), int(m.group(2) or m.group(1))
    return last >= first and len(_forms(a)) == last - first + 1


def _own(name: str, a: Dict[str, Any]) -> Optional[str]:
    """One past-tense line for a finished call of a tool of this app's own, or
    None for a shared one (:data:`core.trace.SHARED_DESCRIBE`)."""
    # --- reads ---------------------------------------------------------------
    if name == 'split_sentence':
        return f'Planned a sentence split at {q(a.get("ref"))}{in_doc(a)}'
    if name == 'merge_sentences':
        return f'Planned joining {q(a.get("ref"))} onto the sentence before it{in_doc(a)}'
    if name == 'search':
        where = a.get('field') or 'the corpus'
        return f'Searched {where} for {q(a.get("pattern"))}{in_docs(a)}'
    if name == 'grew_search':
        return f'Searched with Grew for {q(" ".join(str(a.get("pattern") or "").split()))}{in_docs(a)}'
    if name == 'frequency_list':
        n, what = _ngram(a), a.get('what') or 'lemma'
        unit = (f'{what} {"bigrams" if n == 2 else f"{n}-grams"}' if n
                else _RANKED.get(what, f'{what} values'))
        where = a.get('where')
        held = (' of words with ' + ', '.join(f'{k}={v}' for k, v in where.items())
                if isinstance(where, dict) and where else '')
        return f'Ranked {unit} by frequency{held}{in_docs(a)}'
    if name == 'check_consistency':
        what = f' ({a["kind"]})' if a.get('kind') else ''
        return f'Checked the corpus against itself{what}{in_docs(a)}'
    if name == 'worklist':
        field = f'{a["field"]} ' if a.get('field') else ''
        return f'Listed {a.get("kind") or "unverified"} {field}work{in_docs(a)}'

    # --- plans ---------------------------------------------------------------
    if name == 'set_field':
        what = f'{a.get("field")} = {q(a.get("value"))}' if a.get('value') else f'{a.get("field")} cleared'
        return f'Planned {what} on {plural(count(a), "word")}{in_doc(a)}'
    if name == 'set_feature':
        what = f'{a.get("feature")}={a.get("value")}' if a.get('value') else f'{a.get("feature")} removed'
        return f'Planned {what} on {plural(count(a), "word")}{in_doc(a)}'
    if name == 'set_head':
        head = a.get('head')
        if head == 0:
            return f'Planned {a.get("ref")} as the sentence root{in_doc(a)}'
        return f'Planned {a.get("ref")} as {a.get("deprel")} of word {head}{in_doc(a)}'
    if name == 'del_relation':
        return f'Planned leaving {plural(count(a), "word")} with no head{in_doc(a)}'
    if name == 'confirm':
        field = f' ({a["field"]})' if a.get('field') else ''
        scope = plural(count(a), 'word') if a.get('refs') else 'everything awaiting review'
        return f'Planned confirming {scope}{field}{in_doc(a)}{across(a)}'
    if name == 'replace_in_field':
        return (f'Planned replacing {q(a.get("pattern"))} with {q(a.get("replacement"))} in every '
                f'{a.get("field")}{in_doc(a)}')
    if name == 'set_words':
        forms = _forms(a)
        if _respells(a):
            return f'Planned respelling {a.get("ref")} → {" + ".join(q(f) for f in forms)}{in_doc(a)}'
        if len(forms) == 1:
            return f'Planned {a.get("ref")} as one word {q(forms[0])}{in_doc(a)}'
        return f'Planned {a.get("ref")} as {plural(len(forms), "word")}{in_doc(a)}'
    if name == 'split_token':
        parts = _forms({'forms': a.get('parts')})
        into = f' into {" + ".join(q(p) for p in parts)}' if parts else ' at its spaces'
        return f'Planned splitting {a.get("ref")}{into}{in_doc(a)}'
    if name == 'run_parse':
        n = count(a, 'documents')
        over = ', overwriting human work' if a.get('overwrite') else ''
        return f'Planned re-parsing {plural(n, "document")}{over}'
    if name == 'discard_predictions':
        scope = plural(count(a), 'word') if a.get('refs') else 'every unconfirmed machine value'
        return f'Planned discarding {scope}{in_doc(a)}{across(a)}'

    return None


# --- while it is happening ------------------------------------------------------
# The same call, in the present tense, for the progress line the tab shows
# while the turn runs. Only the calls worth naming get a line of their own.

_PROGRESS = {
    'split_sentence': lambda a: 'Splitting a sentence…',
    'merge_sentences': lambda a: 'Joining two sentences…',
    'search': lambda a: f'Searching for "{a.get("pattern", "")}"…',
    'grew_search': lambda a: 'Running a Grew search…',
    'replace_in_field': lambda a: f'Finding every {a.get("field", "value")} matching "{a.get("pattern", "")}"…',
    'frequency_list': lambda a: 'Counting frequencies…',
    'check_consistency': lambda a: 'Checking the corpus for disagreements…',
    'worklist': lambda a: f'Listing {a.get("kind") or "unfinished"} work…',
    'run_parse': lambda a: 'Checking the parser…',
    'split_token': lambda a: 'Splitting a token…',
    'set_words': lambda a: 'Respelling a token…' if _respells(a) else 'Reshaping a token…',
}


TRACER = tracer_for(WEB_TOOLS, WRITE_TOOLS, _own, _PROGRESS, searches=('grew_search',))
describe_step = TRACER.describe
