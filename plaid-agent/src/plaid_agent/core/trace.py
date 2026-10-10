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
    return f'Read {q(a.get("document"))}{span}'


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
    return f'Reading {q(a.get("document", ""))}{span}…'


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
    was: "Nothing to change: replacing “QQZX” → “3SG” in Gloss", never
    "Planned" over a card that does not hold it."""
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
               said: Optional[str] = None, thought: bool = False, nothing: bool = False) -> Dict[str, Any]:
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
    ``nothing`` marks a plan call that left the plan as it was."""
    kind = tracer.kind(name)
    if kind == DOCUMENT and saw and not failed:
        label = f'Read {q(args.get("document"))}'
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
