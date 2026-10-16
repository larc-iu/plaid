"""What an assistant did before answering, in the reader's terms.

Every tool call a turn makes becomes one trace item next to the reply: the
tool's name, one line saying what it did and what it read, and what kind of
step it was. The Assistant tab shows the summary line, expands it to the
steps, and expands a step to the call's input and the tool's own output, read
from the round the call belongs to (core/rounds.py), stored beside the
conversation.

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
    #: Whether a read is a search: a look for a pattern across the data.
    search: Callable[[str], bool] = lambda name: False
    #: The kind of one call where its arguments decide it, else ``kind``'s
    #: answer: a tool with some actions that plan and some that only read, whose
    #: reading actions are no plan call.
    kind_of: Callable[[str, Dict[str, Any]], str] = None

    def call_kind(self, name: str, args: Dict[str, Any]) -> str:
        return self.kind_of(name, args) if self.kind_of else self.kind(name)


# Bookkeeping rather than a look at the data: the overview, the plan so far,
# the reference pages. ONE list, because two of them drifted: query_help was
# META in one app and READ in the other, so the same tool counted as a look at
# the data in one Assistant tab and not in the other.
META_TOOLS = frozenset({'project_overview', 'list_documents', 'plan_status', 'query_help',
                        'discard_plan', 'drop_planned', 'resume_plan', 'read_guideline'})

# The reads the summary calls searches: a look for a pattern across the data.
# Every other READ (a count, a worklist, a check, a run of code) is a read. An
# app names its own (``tracer_for``'s ``searches``), and these are every app's.
SEARCH_TOOLS = frozenset({'search', 'query'})


def tracer_for(web_tools, write_tools, describe: Callable[[str, Dict[str, Any]], Optional[str]],
               progress: Dict[str, Callable[[Dict[str, Any]], str]], searches=(),
               reading: Optional[Dict[str, Callable[[Dict[str, Any]], Optional[str]]]] = None) -> Tracer:
    """One app's tracer. What KIND a call was is read off the app's own tool
    tables. The lines are the app's for its own tools (``describe`` answers
    None for a tool it has no line for) and :data:`SHARED_DESCRIBE` and
    :data:`SHARED_PROGRESS` for the tools every app offers, so the same tool
    reads the same under a reply in every app. A plan tool with no progress
    line says it is planning, and anything else says its own name.
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

    def line(name: str, args: Dict[str, Any]) -> str:
        own = describe(name, args)
        if own is not None:
            return own
        shared = SHARED_DESCRIBE.get(name)
        return shared(args) if shared else name.replace('_', ' ')

    def label(name: str, args: Dict[str, Any]) -> str:
        fn = progress.get(name) or SHARED_PROGRESS.get(name)
        if fn:
            return fn(args)
        if name in write_tools:
            return 'Planning changes…'
        return f'{name}…'

    def kind_of(name: str, args: Dict[str, Any]) -> str:
        fn = (reading or {}).get(name)
        return (fn(args) if fn else None) or kind(name)

    searching = SEARCH_TOOLS | frozenset(searches)
    return Tracer(kind=kind, describe=line, progress=label, search=lambda name: name in searching,
                  kind_of=kind_of)


# --- the words an app's descriptions are built from -----------------------------
# Shared so two apps phrase the same shapes the same way.

# Embeddings, overrides and isolates inside a value: an isolate keeps an
# override to the value but still applies it there, so a search the model
# wrote as RLO "evil" read "live" in its label.
_FORMATTING = {c: None for c in (*range(0x202A, 0x202F), *range(0x2066, 0x206A))}


def q(v: Any) -> str:
    """A value as the reader sees it, in typographic quotes, isolated
    (:mod:`.bidi`), without the formatting characters that would reorder it."""
    return f'“{iso(None if v is None else str(v).translate(_FORMATTING))}”'


def in_doc(a: Dict[str, Any]) -> str:
    """' in "<document>"', or nothing when the call was project-wide."""
    return f' in {q(a["document"])}' if a.get('document') else ''


def count(a: Dict[str, Any], key: str = 'refs') -> int:
    """How many things an argument names, whether it is a list or one value."""
    v = a.get(key)
    return len(v) if isinstance(v, list) else (1 if v else 0)


def plural(n: int, one: str, many: Optional[str] = None) -> str:
    return f'{n} {one if n == 1 else (many or one + "s")}'


# --- what a call read ----------------------------------------------------------
#
# A tool notes what it showed the model (``ws.note_read``): how many of what,
# out of how many, and which. The step carries the notes as ``saw``, the label
# says them, and the summary counts sentences and documents from them, so a
# column of reads says which sentences each one read rather than looking like
# a scan of the whole corpus.

#: The units a note may count in, with their singular and plural. One list, so
#: the three apps phrase what they read alike.
UNITS = {
    'sentence': ('sentence', 'sentences'),
    'document': ('document', 'documents'),
    'match': ('match', 'matches'),
    'row': ('row', 'rows'),
    'entry': ('entry', 'entries'),
    'word': ('word', 'words'),
    'node': ('node', 'nodes'),
    'comment': ('comment', 'comments'),
    'change': ('change', 'changes'),
    'query': ('query', 'queries'),
    'line': ('line', 'lines'),
    'printed': ('line', 'lines'),
}

#: How long ``which`` may be.
WHICH_MAX = 40


def ranges(numbers: List[Any]) -> str:
    """``3–7, 9, 12–13`` for the numbers in their order, runs of consecutive
    integers joined. Anything not an integer is kept as it is."""
    out: List[str] = []
    run: List[int] = []

    def flush():
        if run:
            out.append(str(run[0]) if len(run) == 1 else f'{run[0]}–{run[-1]}')
            run.clear()
    for n in numbers:
        if isinstance(n, int) and not isinstance(n, bool):
            if run and n == run[-1] + 1:
                run.append(n)
                continue
            flush()
            run.append(n)
        else:
            flush()
            out.append(str(n))
    flush()
    return ', '.join(out)


def note(n: int, unit: str, of: Optional[int] = None, which: Optional[str] = None) -> Dict[str, Any]:
    """One note of what a call read, as the step keeps it."""
    if unit not in UNITS:
        raise ValueError(f'unknown unit {unit!r}')
    out: Dict[str, Any] = {'n': int(n), 'unit': unit}
    if of is not None:
        out['of'] = int(of)
    if which:
        w = str(which)
        out['which'] = w if len(w) <= WHICH_MAX else w[:WHICH_MAX - 1] + '…'
    return out


def say_note(s: Dict[str, Any]) -> str:
    """One note as the label says it: ``sentences 3–7 of 120``, ``30 of 412
    matches``, ``printed 14 lines``."""
    n, unit, of, which = s['n'], s['unit'], s.get('of'), s.get('which')
    one, many = UNITS.get(unit, (unit, unit + 's'))
    word = one if n == 1 else many
    if unit == 'printed':
        return f'printed {n} {word}'
    if which:
        named = f'{word} {which}'
        return f'{named} of {of}' if of is not None else named
    if of is not None and of != n:
        return f'{n} of {of} {many if of != 1 else one}'
    return f'{n} {word}'


def say_saw(saw: Optional[List[Dict[str, Any]]]) -> str:
    """What a call read, every note in its order, or nothing."""
    return ', '.join(say_note(s) for s in saw or ())


def _document(a: Dict[str, Any]) -> str:
    """The document a read names, or "a document" when its arguments name
    none (they did not parse)."""
    return q(a['document']) if a.get('document') else 'a document'


def read_document_label(a: Dict[str, Any]) -> str:
    """The line for a read of a document, with the span it asked for. Used
    only where the read noted nothing it showed (it failed): otherwise the
    step says what was shown (:func:`trace_step`)."""
    span = ''
    picked = a.get('sentences')
    if picked:
        span = f' ({plural(len(picked) if isinstance(picked, list) else 1, "sentence")})'
    elif a.get('from_sentence') or a.get('to_sentence'):
        span = f' (sentences {a.get("from_sentence") or 1}'
        span += f'–{a["to_sentence"]})' if a.get('to_sentence') else ' on)'
    return f'Read {_document(a)}{span}'


def reading_line(a: Dict[str, Any]) -> str:
    """The line shown while a document is read, naming the span asked for."""
    picked = a.get('sentences')
    span = ''
    if picked:
        items = picked if isinstance(picked, list) else [picked]
        span = f', sentences {ranges([_int(i) for i in items])}' if len(items) > 1 \
            else f', sentence {ranges([_int(i) for i in items])}'
    elif a.get('from_sentence') or a.get('to_sentence'):
        span = f', sentences {a.get("from_sentence") or 1}'
        span += f'–{a["to_sentence"]}' if a.get('to_sentence') else ' on'
    return f'Reading {_document(a)}{span}…'


def _int(v: Any) -> Any:
    try:
        return int(v)
    except (TypeError, ValueError):
        return v


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


NOTHING = 'Nothing to change: '


def nothing_label(label: str) -> str:
    """The line for a plan call that went through and left the plan as it
    was: "Nothing to change: replacing ..." where it would have said
    "Planned replacing ...", never "Planned" over a card that does not hold
    it."""
    for done, _tried in _FAILED_VERBS:
        if label.startswith(done):
            return NOTHING + label[len(done):]
    return NOTHING + label


def _the_named_document(s: Dict[str, Any], args: Dict[str, Any]) -> bool:
    """A note that the call read one document, on a call that named it: the
    label already names it, so "1 document" after it says nothing. The step
    keeps the note in ``saw``."""
    return (bool(args.get('document')) and s.get('unit') == 'document' and s.get('n') == 1
            and s.get('of') is None and not s.get('which'))


def trace_step(tracer: Tracer, call_id: str, name: str, args: Dict[str, Any],
               failed: bool = False, planned: int = 0, saved: Optional[List[str]] = None,
               saw: Optional[List[Dict[str, Any]]] = None, round_id: Optional[str] = None,
               said: Optional[str] = None, thought: bool = False, nothing: bool = False,
               told: Optional[str] = None) -> Dict[str, Any]:
    """One trace item. ``document`` rides along on a document read so the
    summary can count distinct documents without re-reading the arguments.
    ``failed`` marks a call the tool refused: it keeps its kind (the tab
    still shows it where it happened) but is left out of every count.
    ``planned`` is how much the call changed the plan's size (negative for a
    drop), so the summary counts the changes the card shows rather than the
    calls that asked for them. ``saved`` names the files the call saved for
    the user (save_file in run_code).

    ``saw`` is what the call read (:func:`note`), said after the label.
    ``round_id`` names the model call it belongs to, whose stored round holds
    its input and output, and ``said`` is the text the model wrote in that
    call, on the round's first step only. ``thought`` says that round holds
    the model's reasoning, on the same step, so the panel offers it.
    ``nothing`` marks a plan call that left the plan as it was. ``told`` is
    the line the tool gave for what it did (``BaseWorkspace.step_label``),
    where the arguments alone would misread it: a value kept out of a
    corpus-wide change is not a change planned."""
    kind = tracer.call_kind(name, args)
    if told and not failed:
        label = told
    elif kind == DOCUMENT and saw and not failed:
        label = f'Read {_document(args)}'
    else:
        label = tracer.describe(name, args)
    shown = [s for s in saw or () if not _the_named_document(s, args)]
    if shown and not failed:
        label = f'{label}: {say_saw(shown)}'
    item = {'id': call_id, 'name': name, 'kind': kind,
            'label': failed_label(label) if failed else nothing_label(label) if nothing else label}
    if failed:
        item['failed'] = True
    elif nothing:
        item['nothing'] = True
    elif kind == DOCUMENT and args.get('document'):
        item['document'] = str(args['document'])
    elif kind == READ and tracer.search(name):
        item['search'] = True
    if planned:
        item['planned'] = planned
    if saved and not failed:
        item['saved'] = list(saved)
    if saw and not failed:
        item['saw'] = list(saw)
    if round_id:
        item['round'] = round_id
    if said:
        item['said'] = said
    if thought:
        item['thought'] = True
    return item


def which_numbers(which: Any) -> Optional[List[int]]:
    """The numbers a ``which`` names (``3–7, 9``), or None when it names
    something else or was cut short."""
    if not isinstance(which, str) or not which or '…' in which:
        return None
    out: List[int] = []
    for piece in which.split(', '):
        lo, _, hi = piece.partition('–')
        if not lo.isdigit() or (hi and not hi.isdigit()):
            return None
        out.extend(range(int(lo), int(hi or lo) + 1))
    return out


def sentences_read(steps: List[Dict[str, Any]]) -> int:
    """The sentences the document reads among ``steps`` showed the model, a
    sentence read twice in one document counted once. A note that does not
    say which sentences counts in full."""
    seen = set()
    loose = 0
    for st in steps:
        if st.get('kind') != DOCUMENT or st.get('failed'):
            continue
        for s in st.get('saw') or ():
            if s.get('unit') != 'sentence':
                continue
            numbers = which_numbers(s.get('which'))
            if numbers is None:
                loose += s['n']
            else:
                seen.update((st.get('document'), n) for n in numbers)
    return len(seen) + loose


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
    sentences = sentences_read(steps)
    if docs and sentences:
        parts.append(f'read {plural(sentences, "sentence")} in {plural(len(docs), "document")}')
    elif docs:
        parts.append(f'read {plural(len(docs), "document")}')
    # A search is a search and any other look at the data a read, as their
    # labels say ("Searched ...", "Read across the corpus"). A run of code that
    # saved a file is counted as the saving, not as a read, and a file saved
    # twice (code run again after a fix) is one file.
    looks = [s for s in steps if s['kind'] == READ and not s.get('saved')]
    searches = sum(1 for s in looks if s.get('search'))
    if searches:
        parts.append(plural(searches, 'search', 'searches'))
    if len(looks) > searches:
        parts.append(plural(len(looks) - searches, 'read'))
    saved = {n.casefold() for s in steps for n in s.get('saved') or ()}
    if saved:
        parts.append('saved ' + plural(len(saved), 'file'))
    web = sum(1 for s in steps if s['kind'] == WEB)
    if web:
        parts.append(plural(web, 'web lookup'))
    if planned > 0:
        parts.append(plural(planned, 'planned change'))
    return ' · '.join(parts + [total]) if parts else total


# --- the tools every app offers ---------------------------------------------------
# One line each, so a shared tool reads the same under a reply in every app. An
# app's own describer answers first, for the tools it declares itself.

def _attached(a: Dict[str, Any]) -> str:
    at = f' from line {a["start_line"]}' if a.get('start_line') else ''
    return f'Read the attached file {q(a.get("name"))}{at}'


def _on_ref(a: Dict[str, Any]) -> str:
    return f' on {a["ref"]}' if a.get('ref') else ''


SHARED_DESCRIBE: Dict[str, Callable[[Dict[str, Any]], str]] = {
    'project_overview': lambda a: 'Looked at the project overview',
    'list_documents': lambda a: 'Listed the documents' + (f' matching {q(a["pattern"])}' if a.get('pattern') else ''),
    'read_document': read_document_label,
    'read_guideline': lambda a: f'Read the guideline {q(a.get("title"))}',
    'add_guideline': lambda a: f'Drafted a guideline, {q(a.get("title"))}',
    'revise_guideline': lambda a: f'Edited the guideline {q(a.get("title"))}',
    'rewrite_guideline': lambda a: f'Rewrote the guideline {q(a.get("title"))}',
    'query_help': lambda a: 'Looked up the query language',
    'query': lambda a: 'Ran a query',
    'recent_changes': lambda a: f'Read the change history{in_doc(a)}',
    'comments': lambda a: f'Read the comments{_on_ref(a)}{in_doc(a)}',
    'add_comment': lambda a: f'Planned a comment on {a.get("ref") or "the document"}{in_doc(a)}',
    'restore_document': lambda a: f'Planned restoring {q(a.get("document"))} to {a.get("as_of", "")}',
    'run_code': lambda a: 'Read across the corpus',
    'code_help': lambda a: 'Looked up how to read across the corpus',
    'read_file': _attached,
    'web_search': lambda a: f'Searched the web for {q(a.get("query"))}',
    'read_url': lambda a: f'Read the web page {a.get("url")}',
    'plan_status': lambda a: 'Reviewed the plan so far',
    'discard_plan': lambda a: 'Discarded the plan so far',
    'drop_planned': lambda a: (f'Dropped {plural(count(a, "indexes"), "planned change")}' if a.get('indexes')
                               else 'Dropped planned changes' + (f' to {a["field"]}' if a.get('field') else '')
                               + in_doc(a)),
    'resume_plan': lambda a: 'Took over the plan from an earlier message',
}

SHARED_PROGRESS: Dict[str, Callable[[Dict[str, Any]], str]] = {
    'project_overview': lambda a: 'Looking at the project…',
    'list_documents': lambda a: 'Listing the documents…',
    'read_document': reading_line,
    'read_guideline': lambda a: f'Reading the guideline "{a.get("title", "")}"…',
    'add_guideline': lambda a: f'Drafting a guideline, "{a.get("title", "")}"…',
    'revise_guideline': lambda a: f'Editing the guideline "{a.get("title", "")}"…',
    'rewrite_guideline': lambda a: f'Rewriting the guideline "{a.get("title", "")}"…',
    'query_help': lambda a: 'Reading the query language…',
    'query': lambda a: 'Running a query…',
    'recent_changes': lambda a: 'Reading the change history…',
    'comments': lambda a: 'Reading the comments…',
    'add_comment': lambda a: 'Planning a comment…',
    'restore_document': lambda a: f'Checking a restore of "{a.get("document", "")}"…',
    'run_code': lambda a: 'Reading across the corpus…',
    'code_help': lambda a: 'Looking up how to read across the corpus…',
    'read_file': lambda a: f'Reading "{a.get("name", "")}"…',
    'web_search': lambda a: f'Searching the web for "{a.get("query", "")}"…',
    'read_url': lambda a: f'Reading {a.get("url", "")}…',
    'plan_status': lambda a: 'Reviewing the plan so far…',
    'discard_plan': lambda a: 'Discarding the plan so far…',
    'drop_planned': lambda a: 'Dropping planned changes…',
    'resume_plan': lambda a: 'Taking over the plan from an earlier message…',
}
