"""UMR's words for its own tools, for the trace next to a reply.

The counting, the summary line and the item shape are in
:mod:`plaid_agent.core.trace`. What a call DID is here, next to the tool table
in :mod:`.toolkit`, so a new tool is described where it is declared. A tool
with no line of its own falls back to its name, and
``tests/test_umr_trace.py`` fails if any declared tool reaches that fallback.
"""

from typing import Any, Dict, Optional

from ..core.args import sentence_number
from ..core.trace import in_doc, q, tracer_for
from .toolkit import WEB_TOOLS, WRITE_TOOLS


def _sentence(raw: Any) -> str:
    """A sentence as the reader writes it, "s7", whether the model passed 7,
    "7" or "s7". Anything that names no sentence is shown as it came."""
    try:
        n = sentence_number(raw)
    except ValueError:
        return str(raw)
    return f's{n}' if n is not None else 'a sentence'


def _own(name: str, a: Dict[str, Any]) -> Optional[str]:
    """One past-tense line for a finished call of a tool of this app's own, or
    None for a shared one (:data:`core.trace.SHARED_DESCRIBE`)."""
    # --- reads ---------------------------------------------------------------
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

    # --- plans ------------------------------------------------------------------
    if name == 'apply_penman':
        return f'Planned a new graph for {_sentence(a.get("sentence"))}{in_doc(a)}'
    if name == 'set_attributes':
        line = (a.get('line') or '').strip()
        what = q(line) if line else 'no attributes'
        return f'Planned {what} on {a.get("var")}{in_doc(a)}'
    if name == 'set_attribute_for_concept':
        rel, value = a.get('rel') or '', (a.get('value') or '').strip()
        what = f'{rel} {value}' if value else f'{rel} removed'
        # Without overwrite a value lands only where the attribute is missing.
        if value and not a.get('overwrite'):
            return f'Planned {what} on {q(a.get("concept"))} nodes without {rel}{in_doc(a)}'
        return f'Planned {what} on every {q(a.get("concept"))} node{in_doc(a)}'
    if name == 'add_triple':
        return f'Planned ({a.get("a")} {a.get("rel")} {a.get("b")}){in_doc(a)}'
    if name == 'delete_triple':
        return f'Planned removing ({a.get("a")} {a.get("rel") or "…"} {a.get("b")}){in_doc(a)}'

    return None


# --- while it is happening --------------------------------------------------------
# The same call, in the present tense, for the progress line the tab shows
# while the turn runs. Only the calls worth naming get a line of their own.

_PROGRESS = {
    'document_graph': lambda a: 'Reading the document graph…',
    'find_nodes': lambda a: 'Looking for nodes…',
    'search': lambda a: 'Searching the corpus…',
    'worklist': lambda a: 'Looking for what is unfinished…',
    'frequency_list': lambda a: 'Counting frequencies…',
    'apply_penman': lambda a: 'Working out what the graph would change…',
    'set_attributes': lambda a: 'Setting attributes…',
    'set_attribute_for_concept': lambda a: 'Working out which nodes that attribute reaches…',
    'add_triple': lambda a: 'Adding a document-level relation…',
    'delete_triple': lambda a: 'Removing a document-level relation…',
}


TRACER = tracer_for(WEB_TOOLS, WRITE_TOOLS, _own, _PROGRESS)
describe_step = TRACER.describe
