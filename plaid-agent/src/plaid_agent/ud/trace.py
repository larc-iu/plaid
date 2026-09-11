"""UD's words for its own tools, for the trace next to a reply.

The counting, the summary line and the item shape are in
:mod:`plaid_agent.core.trace`. What a call DID is here, next to the tool table
in :mod:`.tools`, so a new tool is described where it is declared. A tool with
no line of its own falls back to its name, and ``test_ud_trace.py`` fails if
any declared tool reaches that fallback.
"""

from typing import Any, Dict

from ..core.trace import DOCUMENT, META, PLAN, READ, WEB, Tracer, count, in_doc, plural, q
from .tools import WEB_TOOLS, WRITE_TOOLS

_META_TOOLS = frozenset({'project_overview', 'list_documents', 'plan_status',
                         'discard_plan', 'drop_planned'})


def step_kind(name: str) -> str:
    if name == 'read_document':
        return DOCUMENT
    if name in WEB_TOOLS:
        return WEB
    if name in WRITE_TOOLS:
        return PLAN
    if name in _META_TOOLS:
        return META
    return READ


def _refs(a: Dict[str, Any]) -> str:
    n = count(a)
    return plural(n, 'word') if n != 1 else q((a.get('refs') or [''])[0])


def describe_step(name: str, a: Dict[str, Any]) -> str:
    """One past-tense line for a finished tool call."""
    # --- reads ---------------------------------------------------------------
    if name == 'project_overview':
        return 'Looked at the project overview'
    if name == 'list_documents':
        return 'Listed the documents' + (f' matching {q(a["pattern"])}' if a.get('pattern') else '')
    if name == 'read_document':
        span = ''
        picked = a.get('sentences')
        if picked:
            span = f' ({plural(len(picked), "sentence")})'
        elif a.get('from_sentence') or a.get('to_sentence'):
            span = f' (sentences {a.get("from_sentence") or 1}'
            span += f'–{a["to_sentence"]})' if a.get('to_sentence') else ' on)'
        return f'Read {q(a.get("document"))}{span}'
    if name == 'search':
        where = a.get('field') or 'the corpus'
        return f'Searched {where} for {q(a.get("pattern"))}{in_doc(a)}'
    if name == 'frequency_list':
        return f'Ranked {a.get("what") or "lemma"}s by frequency{in_doc(a)}'
    if name == 'check_consistency':
        what = f' ({a["kind"]})' if a.get('kind') else ''
        return f'Checked the corpus against itself{what}'
    if name == 'worklist':
        field = f'{a["field"]} ' if a.get('field') else ''
        return f'Listed {a.get("kind") or "unverified"} {field}work{in_doc(a)}'
    if name == 'recent_changes':
        return f'Read the change history{in_doc(a)}'
    if name == 'comments':
        where = f' on {a["ref"]}' if a.get('ref') else ''
        return f'Read the comments{where}{in_doc(a)}'
    if name == 'plan_status':
        return 'Reviewed the plan so far'

    # --- outside the project ---------------------------------------------------
    if name == 'web_search':
        return f'Searched the web for {q(a.get("query"))}'
    if name == 'read_url':
        return f'Read the web page {a.get("url")}'

    # --- plans ---------------------------------------------------------------
    if name == 'set_field':
        what = f'{a.get("field")} = {q(a.get("value"))}' if a.get('value') else f'{a.get("field")} cleared'
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
        return f'Planned confirming {scope}{field}{in_doc(a)}'
    if name == 'set_words':
        forms = a.get('forms') or []
        if len(forms) == 1:
            return f'Planned {a.get("ref")} as one word {q(forms[0])}{in_doc(a)}'
        return f'Planned {a.get("ref")} as {plural(len(forms), "word")}{in_doc(a)}'
    if name == 'run_parse':
        n = count(a, 'documents')
        over = ', overwriting human work' if a.get('overwrite') else ''
        return f'Planned re-parsing {plural(n, "document")}{over}'
    if name == 'discard_predictions':
        scope = plural(count(a), 'word') if a.get('refs') else 'every unconfirmed machine value'
        return f'Planned discarding {scope}{in_doc(a)}'

    # --- bookkeeping ----------------------------------------------------------
    if name == 'discard_plan':
        return 'Discarded the plan so far'
    if name == 'drop_planned':
        return f'Dropped {plural(count(a, "indexes"), "planned change")}'
    return name.replace('_', ' ')


# --- while it is happening ------------------------------------------------------
# The same call, in the present tense, for the progress line the tab shows
# while the turn runs. Only the calls worth naming get a line of their own.

_PROGRESS = {
    'project_overview': lambda a: 'Looking at the project…',
    'list_documents': lambda a: 'Listing the documents…',
    'read_document': lambda a: f'Reading "{a.get("document", "")}"…',
    'search': lambda a: f'Searching for "{a.get("pattern", "")}"…',
    'frequency_list': lambda a: 'Counting frequencies…',
    'check_consistency': lambda a: 'Checking the corpus for disagreements…',
    'worklist': lambda a: f'Listing {a.get("kind") or "unfinished"} work…',
    'recent_changes': lambda a: 'Reading the change history…',
    'comments': lambda a: 'Reading the comments…',
    'run_parse': lambda a: 'Checking the parser…',
    'set_words': lambda a: 'Reshaping a token…',
    'plan_status': lambda a: 'Reviewing the plan…',
    'web_search': lambda a: f'Searching the web for "{a.get("query", "")}"…',
    'read_url': lambda a: f'Reading {a.get("url", "")}…',
}


def progress_label(name: str, args: Dict[str, Any]) -> str:
    fn = _PROGRESS.get(name)
    if fn:
        return fn(args)
    if name in WRITE_TOOLS:
        return 'Planning changes…'
    return f'{name}…'


TRACER = Tracer(kind=step_kind, describe=describe_step, progress=progress_label)
