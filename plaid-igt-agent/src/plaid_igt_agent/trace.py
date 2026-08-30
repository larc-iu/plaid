"""What the assistant did before answering, in the reader's terms.

Every tool call a turn makes becomes one trace item next to the reply: the
tool's name, one line saying what it did, and what kind of step it was. The
Assistant tab shows the summary line, expands it to the steps, and expands a
step to the tool's own output, which it reads out of the transcript where it
is already stored (nothing is sent twice).

The wording lives here, next to the tool table in :mod:`.tools`, so a new
tool is described where it is declared rather than in the browser. A tool
with no line of its own falls back to its name, and
``test_trace.py`` fails if any declared tool reaches that fallback.
"""

from typing import Any, Dict, List, Optional

from .tools import WRITE_TOOLS

# What a step was for. The summary counts documents and searches separately,
# and planning steps are what the plan card then shows.
DOCUMENT = 'document'   # read one document
READ = 'read'           # looked at the data some other way
PLAN = 'plan'           # proposed a change
META = 'meta'           # bookkeeping: the overview, the plan so far, the query reference

_META_TOOLS = frozenset({'project_overview', 'list_documents', 'plan_status', 'query_help',
                         'discard_plan', 'drop_planned'})


def step_kind(name: str) -> str:
    if name == 'read_document':
        return DOCUMENT
    if name in WRITE_TOOLS:
        return PLAN
    if name in _META_TOOLS:
        return META
    return READ


def _q(v: Any) -> str:
    return f'“{"" if v is None else v}”'


def _in(a: Dict[str, Any]) -> str:
    return f' in {_q(a["document"])}' if a.get('document') else ''


def _n(a: Dict[str, Any], key: str = 'refs') -> int:
    v = a.get(key)
    return len(v) if isinstance(v, list) else (1 if v else 0)


def _plural(n: int, one: str, many: Optional[str] = None) -> str:
    return f'{n} {one if n == 1 else (many or one + "s")}'


def _entry(a: Dict[str, Any]) -> str:
    return _q(a.get('entry_form') or a.get('entry_id'))


def describe_step(name: str, a: Dict[str, Any]) -> str:
    """One past-tense line for a finished tool call."""
    # --- reads ---------------------------------------------------------------
    if name == 'project_overview':
        return 'Looked at the project overview'
    if name == 'list_documents':
        return 'Listed the documents' + (f' matching {_q(a["pattern"])}' if a.get('pattern') else '')
    if name == 'read_document':
        span = ''
        if a.get('from_sentence') or a.get('to_sentence'):
            span = f' (sentences {a.get("from_sentence") or 1}'
            span += f'–{a["to_sentence"]})' if a.get('to_sentence') else ' on)'
        return f'Read {_q(a.get("document"))}{span}'
    if name == 'search':
        where = a.get('where') if a.get('where') and a['where'] != 'baseline' else 'the baseline'
        return f'Searched {where} for {_q(a.get("pattern"))}{_in(a)}'
    if name == 'read_lexicon':
        return 'Read the lexicon' + (f' for {_q(a["pattern"])}' if a.get('pattern') else '')
    if name == 'concordance':
        scope = f' in {a["where"]}' if a.get('where') and a['where'] != 'morpheme' else ''
        return f'Concordanced {_q(a.get("pattern"))}{scope}{_in(a)}'
    if name == 'analyses_of':
        return f'Tallied the analyses of {_q(a.get("form"))}{_in(a)}'
    if name == 'lexicon_entry':
        return f'Looked up the entry {_entry(a)}'
    if name == 'check_consistency':
        return f'Checked {a.get("field")} for consistency{_in(a)}'
    if name == 'recent_changes':
        return f'Read the change history{_in(a)}'
    if name == 'corpus_stats':
        return 'Counted the corpus' + (f' by {a["by"]}' if a.get('by') else '') + _in(a)
    if name == 'frequency_list':
        return f'Ranked {a.get("what") or "wordform"}s by frequency{_in(a)}'
    if name == 'worklist':
        field = f'{a["field"]} ' if a.get('field') else ''
        return f'Listed {a.get("kind") or "unglossed"} {field}work{_in(a)}'
    if name == 'check_lexicon':
        return 'Checked the lexicon'
    if name == 'check_integrity':
        return f'Checked data integrity{_in(a)}'
    if name == 'sequence_search':
        return f'Searched for a word sequence{_in(a)}'
    if name == 'query_help':
        return 'Read the query language reference'
    if name == 'query':
        return 'Ran a query'
    if name == 'plan_status':
        return 'Reviewed the plan so far'

    # --- plans: one item at a time -------------------------------------------
    if name == 'set_field':
        return f'Planned {a.get("field")} = {_q(a.get("value"))} on {_plural(_n(a), "item")}{_in(a)}'
    if name == 'set_analysis':
        return f'Planned a new analysis for {a.get("ref")}{_in(a)}'
    if name == 'set_orthography':
        return f'Planned {a.get("orthography")} = {_q(a.get("value"))} on {_plural(_n(a), "word")}{_in(a)}'
    if name == 'respell':
        return f'Planned respelling {a.get("ref")} → {_q(a.get("new_text"))}{_in(a)}'
    if name == 'link_entry':
        return f'Planned linking {_plural(_n(a), "item")} to {_entry(a)}{_in(a)}'
    if name == 'unlink_entry':
        return f'Planned unlinking {_plural(_n(a), "item")}{_in(a)}'
    if name == 'confirm':
        what = f' ({a["field"]})' if a.get('field') else ''
        scope = _plural(_n(a), 'item') if a.get('refs') else 'everything unverified'
        return f'Planned confirming {scope}{what}{_in(a)}'
    if name == 'discard_analysis':
        return f'Planned discarding the unverified analysis of {_plural(_n(a), "item")}{_in(a)}'

    # --- plans: across the corpus --------------------------------------------
    if name == 'replace_in_field':
        return (f'Planned replacing {_q(a.get("pattern"))} → {_q(a.get("replacement"))} '
                f'in {a.get("field")}{_in(a)}')
    if name == 'respell_all':
        return f'Planned respelling {_q(a.get("pattern"))} → {_q(a.get("replacement"))}{_in(a)}'
    if name == 'copy_to_orthography':
        return f'Planned filling {a.get("orthography")} from {a.get("source") or "the baseline"}{_in(a)}'
    if name == 'set_field_for_form':
        return f'Planned {a.get("field")} = {_q(a.get("value"))} on every {_q(a.get("form"))}{_in(a)}'
    if name == 'set_analysis_for_form':
        return f'Planned an analysis for every {_q(a.get("form"))}{_in(a)}'

    # --- plans: the lexicon ---------------------------------------------------
    if name == 'create_entry':
        return f'Planned a new lexicon entry {_q(a.get("form"))}'
    if name == 'set_entry_field':
        return f'Planned {a.get("field")} = {_q(a.get("value"))} on entry {_entry(a)}'
    if name == 'merge_entries':
        return (f'Planned merging {_q(a.get("remove_form") or a.get("remove_id"))} into '
                f'{_q(a.get("keep_form") or a.get("keep_id"))}')
    if name == 'delete_entry':
        return f'Planned deleting the entry {_entry(a)}'
    if name == 'rename_entry':
        return f'Planned renaming the entry {_entry(a)} → {_q(a.get("new_form"))}'

    # --- plans: documents and the shape of the text ---------------------------
    if name == 'set_document_metadata':
        return f'Planned {a.get("field")} = {_q(a.get("value"))} on document {_q(a.get("document"))}'
    if name == 'create_document':
        return f'Planned a new document {_q(a.get("name"))}'
    if name == 'rename_document':
        return f'Planned renaming {_q(a.get("document"))} → {_q(a.get("new_name"))}'
    if name == 'split_word':
        return f'Planned splitting the word {a.get("ref")} at {_q(a.get("at"))}{_in(a)}'
    if name == 'merge_words':
        return f'Planned merging {_plural(_n(a), "word")} into one{_in(a)}'
    if name == 'delete_word':
        return f'Planned deleting {_plural(_n(a), "word token")}{_in(a)}'
    if name == 'split_sentence':
        return f'Planned splitting {a.get("ref")} before word {a.get("before_word")}{_in(a)}'
    if name == 'merge_sentences':
        return f'Planned merging {a.get("ref")} into the sentence before it{_in(a)}'
    if name == 'append_text':
        return f'Planned adding text to the end of {_q(a.get("document"))}'
    if name == 'retype_sentence':
        return f'Planned retyping {a.get("ref")}{_in(a)}'

    # --- bookkeeping ----------------------------------------------------------
    if name == 'discard_plan':
        return 'Discarded the plan so far'
    if name == 'drop_planned':
        return f'Dropped {_plural(_n(a, "indexes"), "planned change")}'
    return name.replace('_', ' ')


def trace_step(call_id: str, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """One trace item. ``document`` rides along on a document read so the
    summary can count distinct documents without re-reading the arguments."""
    kind = step_kind(name)
    item = {'id': call_id, 'name': name, 'kind': kind, 'label': describe_step(name, args)}
    if kind == DOCUMENT and args.get('document'):
        item['document'] = str(args['document'])
    return item


def summarize_steps(steps: List[Dict[str, Any]]) -> str:
    """The one line the trace collapses to."""
    docs = {s['document'] for s in steps if s.get('document')}
    parts = []
    if docs:
        parts.append(f'read {_plural(len(docs), "document")}')
    reads = sum(1 for s in steps if s['kind'] == READ)
    if reads:
        parts.append(_plural(reads, 'search', 'searches'))
    planned = sum(1 for s in steps if s['kind'] == PLAN)
    if planned:
        parts.append(_plural(planned, 'planned change'))
    total = _plural(len(steps), 'step')
    return ' · '.join(parts + [total]) if parts else total


# --- while it is happening ------------------------------------------------------
# The same call, in the present tense, for the progress line the tab shows
# while the turn runs. Only the calls worth naming get a line of their own.

_PROGRESS = {
    'project_overview': lambda a: 'Looking at the project…',
    'list_documents': lambda a: 'Listing the documents…',
    'read_document': lambda a: f'Reading "{a.get("document", "")}"…',
    'search': lambda a: f'Searching for "{a.get("pattern", "")}"…',
    'read_lexicon': lambda a: 'Reading the lexicon…',
    'concordance': lambda a: f'Concordancing "{a.get("pattern", "")}"…',
    'analyses_of': lambda a: f'Tallying analyses of "{a.get("form", "")}"…',
    'lexicon_entry': lambda a: f'Looking up "{a.get("entry_form") or a.get("entry_id") or ""}"…',
    'check_consistency': lambda a: f'Checking {a.get("field", "")} consistency…',
    'recent_changes': lambda a: 'Reading the change history…',
    'corpus_stats': lambda a: 'Counting the corpus…',
    'frequency_list': lambda a: 'Counting frequencies…',
    'worklist': lambda a: f'Listing {a.get("kind") or "unfinished"} work…',
    'check_lexicon': lambda a: 'Checking the lexicon…',
    'check_integrity': lambda a: 'Checking data integrity…',
    'sequence_search': lambda a: 'Searching for the sequence…',
    'query_help': lambda a: 'Reading the query reference…',
    'query': lambda a: 'Running a query…',
}


def progress_label(name: str, args: Dict[str, Any]) -> str:
    fn = _PROGRESS.get(name)
    if fn:
        return fn(args)
    if name in WRITE_TOOLS:
        return 'Planning changes…'
    return f'{name}…'
