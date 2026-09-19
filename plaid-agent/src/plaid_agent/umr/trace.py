"""UMR's words for its own tools, for the trace next to a reply.

The counting, the summary line and the item shape are in
:mod:`plaid_agent.core.trace`. What a call DID is here, next to the tool table
in :mod:`.toolkit`, so a new tool is described where it is declared. A tool
with no line of its own falls back to its name, and
``tests/test_umr_trace.py`` fails if any declared tool reaches that fallback.
"""

from typing import Any, Dict

from ..core.trace import count, in_doc, plural, q, tracer_for
from .toolkit import WEB_TOOLS, WRITE_TOOLS


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
    if name == 'document_graph':
        return f'Read the document graph of {q(a.get("document"))}'
    if name == 'find_nodes':
        what = (a.get('concept') or a.get('role') or a.get('attribute') or '')
        return f'Looked for nodes matching {q(what)}{in_doc(a)}'
    if name == 'search':
        where = 'concepts' if a.get('where') == 'concepts' else 'words'
        return f'Searched the {where} for {q(a.get("pattern"))}{in_doc(a)}'
    if name == 'worklist':
        return f'Looked at what is unfinished{in_doc(a)}'
    if name == 'frequency_list':
        return f'Ranked {a.get("what") or "concept"}s by frequency{in_doc(a)}'
    if name == 'recent_changes':
        return f'Read the change history{in_doc(a)}'
    if name == 'comments':
        return f'Read the comments{in_doc(a)}'
    if name == 'read_guideline':
        return f'Read the guideline {q(a.get("title"))}'
    if name == 'query_help':
        return 'Looked up the query language'
    if name == 'query':
        return 'Ran a query'
    if name == 'plan_status':
        return 'Reviewed the plan so far'

    # --- outside the project ---------------------------------------------------
    if name == 'web_search':
        return f'Searched the web for {q(a.get("query"))}'
    if name == 'read_url':
        return f'Read the web page {a.get("url")}'

    # --- plans ------------------------------------------------------------------
    if name == 'apply_penman':
        return f'Planned a new graph for s{a.get("sentence")}{in_doc(a)}'
    if name == 'set_attributes':
        line = (a.get('line') or '').strip()
        what = q(line) if line else 'no attributes'
        return f'Planned {what} on {a.get("var")}{in_doc(a)}'
    if name == 'set_attribute_for_concept':
        rel, value = a.get('rel') or '', (a.get('value') or '').strip()
        what = f'{rel} {value}' if value else f'{rel} removed'
        return f'Planned {what} on every {q(a.get("concept"))} node{in_doc(a)}'
    if name == 'add_triple':
        return f'Planned ({a.get("a")} {a.get("rel")} {a.get("b")}){in_doc(a)}'
    if name == 'delete_triple':
        return f'Planned removing ({a.get("a")} {a.get("rel") or "…"} {a.get("b")}){in_doc(a)}'
    if name == 'add_guideline':
        return f'Drafted a guideline, {q(a.get("title"))}'
    if name == 'revise_guideline':
        return f'Edited the guideline {q(a.get("title"))}'
    if name == 'rewrite_guideline':
        return f'Rewrote the guideline {q(a.get("title"))}'
    if name == 'run_code':
        return 'Ran code over the corpus'
    if name == 'code_help':
        return 'Read what code can see'

    # --- bookkeeping --------------------------------------------------------------
    if name == 'discard_plan':
        return 'Discarded the plan so far'
    if name == 'drop_planned':
        return f'Dropped {plural(count(a, "indexes"), "planned change")}'
    return name.replace('_', ' ')


# --- while it is happening --------------------------------------------------------
# The same call, in the present tense, for the progress line the tab shows
# while the turn runs. Only the calls worth naming get a line of their own.

_PROGRESS = {
    'project_overview': lambda a: 'Looking at the project…',
    'list_documents': lambda a: 'Listing the documents…',
    'read_document': lambda a: f'Reading "{a.get("document", "")}"…',
    'document_graph': lambda a: 'Reading the document graph…',
    'find_nodes': lambda a: 'Looking for nodes…',
    'search': lambda a: 'Searching the corpus…',
    'worklist': lambda a: 'Looking for what is unfinished…',
    'frequency_list': lambda a: 'Counting frequencies…',
    'recent_changes': lambda a: 'Reading the change history…',
    'comments': lambda a: 'Reading the comments…',
    'read_guideline': lambda a: f'Reading the guideline "{a.get("title", "")}"…',
    'add_guideline': lambda a: f'Drafting a guideline, "{a.get("title", "")}"…',
    'revise_guideline': lambda a: f'Editing the guideline "{a.get("title", "")}"…',
    'rewrite_guideline': lambda a: f'Rewriting the guideline "{a.get("title", "")}"…',
    'apply_penman': lambda a: 'Working out what the graph would change…',
    'set_attributes': lambda a: 'Setting attributes…',
    'set_attribute_for_concept': lambda a: 'Working out which nodes that attribute reaches…',
    'add_triple': lambda a: 'Adding a document-level relation…',
    'delete_triple': lambda a: 'Removing a document-level relation…',
    'query': lambda a: 'Running a query…',
    'query_help': lambda a: 'Reading the query language…',
    'run_code': lambda a: 'Running code…',
    'code_help': lambda a: 'Reading what code can see…',
    'plan_status': lambda a: 'Reviewing the plan…',
    'web_search': lambda a: f'Searching the web for "{a.get("query", "")}"…',
    'read_url': lambda a: f'Reading {a.get("url", "")}…',
    'discard_plan': lambda a: 'Discarding the plan so far…',
    'drop_planned': lambda a: 'Dropping planned changes…',
}


TRACER = tracer_for(WEB_TOOLS, WRITE_TOOLS, describe_step, _PROGRESS)
