"""What an assistant did before answering, in the reader's terms.

Every tool call a turn makes becomes one trace item next to the reply: the
tool's name, one line saying what it did, and what kind of step it was. The
Assistant tab shows the summary line, expands it to the steps, and expands a
step to the tool's own output, which it reads out of the transcript where it
is already stored (nothing is sent twice).

The WORDING is the app's, next to its own tool table: a new tool is described
where it is declared rather than in the browser. An app hands the core a
:class:`Tracer` carrying the three questions the core asks about a tool call,
and the counting and the summary line are the same for every app.
"""

from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

# What a step was for. The summary counts documents and searches separately,
# and planning steps are what the plan card then shows.
DOCUMENT = 'document'   # read one document
READ = 'read'           # looked at the data some other way
PLAN = 'plan'           # proposed a change
WEB = 'web'             # looked outside the project altogether
META = 'meta'           # bookkeeping: the overview, the plan so far, the query reference


@dataclass(frozen=True)
class Tracer:
    """An app's words for its own tools.

    ``kind`` answers which of the five kinds above a tool call was.
    ``describe`` is one past-tense line for a finished call, ``progress`` the
    same call in the present tense for the line shown while the turn runs.
    A tool with no line of its own falls back to its name.
    """
    kind: Callable[[str], str]
    describe: Callable[[str, Dict[str, Any]], str]
    progress: Callable[[str, Dict[str, Any]], str]


# --- the words an app's descriptions are built from -----------------------------
# Shared so two apps phrase the same shapes the same way.

def q(v: Any) -> str:
    """A value as the reader sees it, in typographic quotes."""
    return f'“{"" if v is None else v}”'


def in_doc(a: Dict[str, Any]) -> str:
    """' in "<document>"', or nothing when the call was project-wide."""
    return f' in {q(a["document"])}' if a.get('document') else ''


def count(a: Dict[str, Any], key: str = 'refs') -> int:
    """How many things an argument names, whether it is a list or one value."""
    v = a.get(key)
    return len(v) if isinstance(v, list) else (1 if v else 0)


def plural(n: int, one: str, many: Optional[str] = None) -> str:
    return f'{n} {one if n == 1 else (many or one + "s")}'


# --- items ----------------------------------------------------------------------

def trace_step(tracer: Tracer, call_id: str, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """One trace item. ``document`` rides along on a document read so the
    summary can count distinct documents without re-reading the arguments."""
    kind = tracer.kind(name)
    item = {'id': call_id, 'name': name, 'kind': kind, 'label': tracer.describe(name, args)}
    if kind == DOCUMENT and args.get('document'):
        item['document'] = str(args['document'])
    return item


def summarize_steps(steps: List[Dict[str, Any]]) -> str:
    """The one line the trace collapses to."""
    docs = {s['document'] for s in steps if s.get('document')}
    parts = []
    if docs:
        parts.append(f'read {plural(len(docs), "document")}')
    reads = sum(1 for s in steps if s['kind'] == READ)
    if reads:
        parts.append(plural(reads, 'search', 'searches'))
    web = sum(1 for s in steps if s['kind'] == WEB)
    if web:
        parts.append(plural(web, 'web lookup'))
    planned = sum(1 for s in steps if s['kind'] == PLAN)
    if planned:
        parts.append(plural(planned, 'planned change'))
    total = plural(len(steps), 'step')
    return ' · '.join(parts + [total]) if parts else total
