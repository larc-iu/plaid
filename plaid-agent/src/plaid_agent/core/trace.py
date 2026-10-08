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

from .bidi import iso

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


# Bookkeeping rather than a look at the data: the overview, the plan so far,
# the reference pages. ONE list, because two of them drifted: query_help was
# META in one app and READ in the other, so the same tool counted as a look at
# the data in one Assistant tab and not in the other.
META_TOOLS = frozenset({'project_overview', 'list_documents', 'plan_status', 'query_help',
                        'discard_plan', 'drop_planned', 'read_guideline'})


def tracer_for(web_tools, write_tools, describe: Callable[[str, Dict[str, Any]], str],
               progress: Dict[str, Callable[[Dict[str, Any]], str]]) -> Tracer:
    """One app's tracer. What KIND a call was is read off the app's own tool
    tables, and the line shown while it runs off the app's ``progress`` map,
    with the same two fallbacks in every app: a plan tool says it is planning,
    and anything else says its own name.
    """
    def kind(name: str) -> str:
        if name == 'read_document':
            return DOCUMENT
        if name in web_tools:
            return WEB
        if name in write_tools:
            return PLAN
        if name in META_TOOLS:
            return META
        return READ

    def label(name: str, args: Dict[str, Any]) -> str:
        fn = progress.get(name)
        if fn:
            return fn(args)
        if name in write_tools:
            return 'Planning changes…'
        return f'{name}…'

    return Tracer(kind=kind, describe=describe, progress=label)


# --- the words an app's descriptions are built from -----------------------------
# Shared so two apps phrase the same shapes the same way.

def q(v: Any) -> str:
    """A value as the reader sees it, in typographic quotes, isolated
    (:mod:`.bidi`)."""
    return f'“{iso(v)}”'


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

# A failed step reads as what it tried, never as done: "Planned X" on a call
# the tool refused would say a change was made that the card does not hold.
_FAILED_VERBS = (('Planned ', 'Could not plan '), ('Drafted ', 'Could not draft '),
                 ('Edited ', 'Could not edit '), ('Rewrote ', 'Could not rewrite '))


def failed_label(label: str) -> str:
    """The line for a call whose tool answered with an error. A read keeps
    its own line (the tab already shows the step in red with the error under
    it), a change says it could not be made."""
    for done, tried in _FAILED_VERBS:
        if label.startswith(done):
            return tried + label[len(done):]
    return label


def trace_step(tracer: Tracer, call_id: str, name: str, args: Dict[str, Any],
               failed: bool = False, planned: int = 0, saved: Optional[List[str]] = None) -> Dict[str, Any]:
    """One trace item. ``document`` rides along on a document read so the
    summary can count distinct documents without re-reading the arguments.
    ``failed`` marks a call the tool refused: it keeps its kind (the tab
    still shows it where it happened) but is left out of every count.
    ``planned`` is how much the call changed the plan's size (negative for a
    drop), so the summary counts the changes the card shows rather than the
    calls that asked for them. ``saved`` names the files the call saved for
    the user (save_file in run_code)."""
    kind = tracer.kind(name)
    label = tracer.describe(name, args)
    item = {'id': call_id, 'name': name, 'kind': kind,
            'label': failed_label(label) if failed else label}
    if failed:
        item['failed'] = True
    elif kind == DOCUMENT and args.get('document'):
        item['document'] = str(args['document'])
    if planned:
        item['planned'] = planned
    if saved and not failed:
        item['saved'] = list(saved)
    return item


def summarize_steps(steps: List[Dict[str, Any]]) -> str:
    """The one line the trace collapses to."""
    total = plural(len(steps), 'step')
    # The changes the plan holds, not the calls that staged them: one graph
    # replacement is seven changes, and a refused call is none. The step line
    # said "7 planned changes" over a card listing 9. Read off every step,
    # since what a step did to the plan is what the card shows.
    planned = sum(s.get('planned') or 0 for s in steps)
    steps = [s for s in steps if not s.get('failed')]
    docs = {s['document'] for s in steps if s.get('document')}
    parts = []
    if docs:
        parts.append(f'read {plural(len(docs), "document")}')
    # A run of code that saved a file is counted as the saving, not as a
    # search, and a file saved twice (code run again after a fix) is one file.
    reads = sum(1 for s in steps if s['kind'] == READ and not s.get('saved'))
    if reads:
        parts.append(plural(reads, 'search', 'searches'))
    saved = {n.casefold() for s in steps for n in s.get('saved') or ()}
    if saved:
        parts.append('saved ' + plural(len(saved), 'file'))
    web = sum(1 for s in steps if s['kind'] == WEB)
    if web:
        parts.append(plural(web, 'web lookup'))
    if planned > 0:
        parts.append(plural(planned, 'planned change'))
    return ' · '.join(parts + [total]) if parts else total
