"""Running code the model wrote, against a plain-data view of the project.

The curated reads answer the questions they were written for, and a corpus
question is often one step past them: a loop, a join, a tally over two
columns. Each such question used to cost another tool, or fifty rounds of
paging. Code answers it in ONE call.

Where it runs: a ``monty`` worker subprocess (the ``pydantic-monty``
package), a Python interpreter with no filesystem, no network, and nothing
to import beyond a small standard library. The project reaches it only
through the host functions an app lends (``documents``, ``load``, ``query``,
``plan``), and each of those is one of the assistant's own tools: ``load``
reads under the requester's token, ``plan`` stages a proposal through the
same guards as the plan tools. No client crosses the boundary, so code
cannot write, and the approval card stays the contract.

The tool exists only where the worker binary is present, the way the web
tools exist only where a search backend is configured: a model that cannot
run code is never told that it can.
"""

import ast
import atexit
import threading
from typing import Any, Callable, Dict, List, Optional

from .limits import MAX_RESULT_CHARS
from .tools import ToolError

# Characters of output handed back. Literally every tool result's budget, not
# a number of its own that happens to match.
OUTPUT_MAX = MAX_RESULT_CHARS
# Every run happens in the turn's own worker, so TURN_EXEC_SECONDS is the only
# interpreter budget there is, and the one the help and the timeout message
# name. There used to be a second one for a fresh worker per call, which no
# tool ever asked for.
WALL_SECONDS = 900.0               # the host-side backstop for one call, host functions included
MEMORY_BYTES = 1024 * 1024 * 1024
MAX_SUSPENSIONS = 500_000          # host calls one run may make: a walk over a large corpus is thousands
TURN_EXEC_SECONDS = 600.0          # interpreter time over a whole turn's calls, which share one worker
MODULES = ('re', 'json', 'math', 'collections', 'itertools', 'functools', 'datetime', 'unicodedata')

NAMES = ('run_code', 'code_help')


# What every turn's worker defines before the model's first run: the reader
# :func:`keyed` sends an attribute read through. Monty runs no __getattr__ and
# no subclass of dict, so a value that answers both doc["sentences"] and
# doc.sentences cannot be built. The model writes both (a quarter of the
# failed run_code calls of the 2026-10-08 benchmark were doc.sentences on
# what load() returns), so the attribute form is turned into the key form
# before the code runs. A key that is not there names the keys that are.
PRELUDE = '''
def _plaid_attr_(o, name):
    if type(o) is dict:
        if name in o:
            return o[name]
        raise AttributeError('no "' + name + '" here. Its keys: ' + ', '.join([repr(k) for k in o]))
    return getattr(o, name)
'''

# Attribute names a dict could never mean as a key in a model's code (every
# method and attribute of the builtin types), and the names that are modules
# or types rather than data. An attribute read of either kind is left as
# written, so str.lower or math.pi never pass through the reader.
_BUILTIN_ATTRS = frozenset(name for t in (str, bytes, list, tuple, dict, set, frozenset, int, float, complex,
                                          bool, BaseException, type(None), object)
                           for name in dir(t))
_MODULE_NAMES = frozenset(MODULES + ('str', 'bytes', 'list', 'tuple', 'dict', 'set', 'frozenset', 'int', 'float',
                                     'complex', 'bool', 'object', 'type'))


def keyed(code: str) -> str:
    """``code`` with every attribute read that may be a key of a loaded
    document sent through the prelude's reader: ``doc.sentences`` becomes
    ``_plaid_attr_(doc, 'sentences')``, which reads the key of a dict and the
    attribute of anything else. A method call (``w.get(...)``,
    ``s.lower()``), an assignment, a builtin's own attribute and a module's
    are left alone. The text around each read is untouched, so line numbers
    in a traceback still match the code the model wrote. Code that does not
    parse is returned as it is, for the sandbox to report."""
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError):
        return code
    called = {id(n.func) for n in ast.walk(tree) if isinstance(n, ast.Call)}
    reads = [n for n in ast.walk(tree)
             if isinstance(n, ast.Attribute) and isinstance(n.ctx, ast.Load) and id(n) not in called
             and n.attr not in _BUILTIN_ATTRS
             and not (isinstance(n.value, ast.Name) and n.value.id in _MODULE_NAMES)]
    if not reads:
        return code
    src = code.encode('utf-8')
    starts, at = [], 0
    for line in src.splitlines(keepends=True):
        starts.append(at)
        at += len(line)
    starts.append(at)

    def pos(line: int, col: int) -> int:
        return starts[line - 1] + col

    edits = []
    for n in reads:
        value_end = pos(n.value.end_lineno, n.value.end_col_offset)
        end = pos(n.end_lineno, n.end_col_offset)
        # What lies between the value and the name: a closing bracket,
        # space, a comment, then the dot. The last dot is the attribute's.
        dot = value_end + src[value_end:end].rindex(b'.')
        edits.append((dot, end, f', {n.attr!r})'.encode('utf-8')))
        edits.append((pos(n.lineno, n.col_offset), None, b'_plaid_attr_('))
    for at, end, text in sorted(edits, key=lambda e: e[0], reverse=True):
        src = src[:at] + text + src[at if end is None else end:]
    return src.decode('utf-8')


class CodeError(Exception):
    """A run that did not finish, in words the model can act on."""


_state: Dict[str, Any] = {'checked': False, 'reason': None, 'pool': None}
_lock = threading.Lock()


def available() -> Optional[str]:
    """None when code can run here, else the reason it cannot. Checked once
    per process: the answer is the operator's installation, not the turn."""
    with _lock:
        if _state['checked']:
            return _state['reason']
        _state['checked'] = True
        try:
            from pydantic_monty import Monty  # noqa: F401
            from pydantic_monty._binary import find_monty_binary
            find_monty_binary()
        except ImportError:
            _state['reason'] = 'the pydantic-monty package is not installed'
        except Exception as e:  # noqa: BLE001 - the finder's own words say where it looked
            _state['reason'] = f'the monty worker binary was not found ({e})'
        return _state['reason']


def _pool():
    """One pool of workers per process, opened on first use and closed at
    exit. A turn checks one out and gives it back when the turn ends, so no
    state leaks from one turn to the next."""
    with _lock:
        if _state['pool'] is None:
            from pydantic_monty import Monty
            pool = Monty(request_timeout=WALL_SECONDS)
            pool.__enter__()
            atexit.register(lambda: pool.__exit__(None, None, None))
            _state['pool'] = pool
        return _state['pool']


class Session:
    """One worker, held for a turn, so what one run_code call computed is
    there for the next: a tally built by a walk can be queried again without
    walking again. Opened on first use, closed by the workspace at the end
    of the turn, and replaced after a crash."""

    def __init__(self):
        self._cm = None
        self._session = None

    def get(self):
        if self._session is None:
            self._cm = _pool().checkout(limits={'max_duration_secs': TURN_EXEC_SECONDS,
                                                 'max_memory': MEMORY_BYTES,
                                                 'max_suspensions': MAX_SUSPENSIONS})
            self._session = self._cm.__enter__()
            self._session.feed_run(PRELUDE, external_lookup={})
        return self._session

    def close(self) -> None:
        cm, self._cm, self._session = self._cm, None, None
        if cm is not None:
            try:
                cm.__exit__(None, None, None)
            except Exception:  # noqa: BLE001 - a worker that is already gone has nothing to release
                pass


def _explain(e, shape: str = '') -> str:
    """The sandbox's error, with a line about what the sandbox has where the
    error is about what it lacks, and the shape of a loaded document where
    the error is a key the code guessed."""
    text = e.display(format='traceback') if hasattr(e, 'display') else str(e)
    text = text.strip()
    if 'ModuleNotFoundError' in text or 'ImportError' in text:
        text += ('\nThe sandbox has these modules and no others: ' + ', '.join(MODULES)
                 + ', and not every name in each of them. Everything about the project comes through '
                 'documents(), load(), query() and plan().')
    if "'list' object is not an iterator" in text:
        text += '\nA generator expression is a list in this sandbox: write next(iter(...)).'
    if shape and ('KeyError' in text or 'Its keys:' in text):
        text += '\nWhat load() returns:\n' + shape
    return text


def run(code: str, api: Dict[str, Callable], *, session: Session, shape: str = '') -> str:
    """Run ``code`` with ``api`` as its host functions, in ``session``: the
    turn's own worker, so names persist from one call to the next. Returns
    what it printed and the value of its last expression, capped. Raises
    :class:`CodeError` with the reason when it did not finish. ``shape`` is
    the app's short example of a loaded document, added to an error about a
    key the code guessed."""
    reason = available()
    if reason:
        raise CodeError(f'Code cannot run on this assistant: {reason}.')
    if not isinstance(code, str) or not code.strip():
        raise CodeError('Give code to run, as a string.')
    from pydantic_monty import (CollectString, MontyCrashedError, MontyRuntimeError, MontySyntaxError,
                                MontyTypingError)
    printed = CollectString(max_bytes=4 * 1024 * 1024)
    try:
        value = session.get().feed_run(keyed(code), external_lookup=dict(api), print_callback=printed)
    except MontyRuntimeError as e:
        raise CodeError(_explain(e, shape) + _partial(printed))
    except (MontySyntaxError, MontyTypingError) as e:
        # Code that does not parse is the code's fault, said in the parser's
        # words. It used to fall through to "a fault in the tool".
        raise CodeError('The code could not be read: ' + _explain(e))
    except MontyCrashedError as e:
        session.close()  # the worker is gone; the next call gets a new one, and starts over
        if getattr(e, 'timed_out', False):
            # Two limits can end a run and the message used to name only the
            # larger, which is not the one that trips first.
            raise CodeError(
                f'The code was stopped. One turn\'s run_code calls share {TURN_EXEC_SECONDS / 60:.0f} '
                f'minutes of computation between them, and one call may take {WALL_SECONDS / 60:.0f} '
                f'minutes including the time its reads wait on the server. Narrow it: fewer documents, '
                f'or a query() for the counting.' + _partial(printed))
        raise CodeError('The sandbox stopped while running this code. Try again with less at once.'
                        + _partial(printed))
    out = (printed.output or '').rstrip('\n')
    if value is not None:
        out = (out + '\n' if out and not out.endswith('\n') else out) + f'=> {value!r}'
    if not out.strip():
        return 'The code ran and printed nothing, and its last line had no value. Print what you want to see.'
    return _truncate(out)


def _partial(printed) -> str:
    text = (printed.output or '').strip()
    if not text:
        return ''
    return '\n\nPrinted before it stopped:\n' + _truncate(text, OUTPUT_MAX // 4)


def _truncate(s: str, cap: int = OUTPUT_MAX) -> str:
    if len(s) <= cap:
        return s
    return s[:cap] + f'\n... [truncated: {len(s) - cap} more characters; print less, or summarize in the code]'


HELP = '''\
{shape}
run_code runs Python you write, in a sandbox with no filesystem, no network and no packages: only the
standard-library modules {modules}. It is for a question the reads do not answer directly: a loop over
many documents, a join between two columns, a tally under your own conditions, a check across the corpus.
It is not for what a single tool already answers.

The project reaches the code through four functions, and nothing else:
  documents()                 -> [{{"id", "name"}}, ...] every document in the project
  load(document)              -> a plain-data view of one document (its shape is below); by id, by name,
                                 or by an entry of documents()
  query(q)                    -> the engine's answer to a query object, as query_help describes it
                                 (layers by name; "results" holds the rows as plain dicts)
  plan(tool, **args)          -> stage a proposal through a plan tool by name, with the same arguments
                                 the tool takes; returns the tool's own reply as text. Nothing is written:
                                 the user approves the plan afterwards, exactly as with the tools.
Names persist between run_code calls in one turn (a tally built by one call can be read by the next);
the next turn starts clean.
What load() returns is dicts and lists, and a key also reads as an attribute: doc.sentences is
doc["sentences"].
Print what you want to see; the value of the last expression is returned too. Output is capped at
{output_max} characters, so summarize in the code rather than printing everything. A turn's run_code
calls share one budget of {turn_seconds:.0f} seconds of computation between them; loading a document is
a call to the server and does not count against it, but a walk over a very large corpus is slow, so use
query() for counting where it can count. Errors come back as text; fix the code and run again.
'''


# Added to the help only in a turn that may read other projects.
PROJECTS_HELP = '''
OTHER PROJECTS
  documents(), load(document) and query(q) each take project="<name>" to read one of the other projects
  in this conversation: {labels}. Without it they read "{home}". plan() stages changes in "{home}" only.
'''


def help_text(app_half: str, extra: str = '', ws=None, shape: str = '') -> str:
    """The app's short example of a loaded document first, then the shared
    half, the app's half, and whatever this conversation adds to both: the
    files the user attached (see :func:`.filetools.code_help`), the files the
    turn can give the user (:func:`.filetools.save_help`), and the other
    projects the turn may read, when there are any."""
    from . import filetools
    out = (HELP.format(modules=', '.join(MODULES), output_max=OUTPUT_MAX, turn_seconds=TURN_EXEC_SECONDS,
                       shape='{shape}').replace('{shape}\n', shape.strip('\n') + '\n\n' if shape else '')
           + app_half + extra + filetools.save_help(ws))
    reach = getattr(ws, 'reach', None)
    if reach is not None and reach.others:
        labels = reach.labels()
        out += (PROJECTS_HELP.replace('{home}', labels[0])
                .replace('{labels}', ', '.join(f'"{label}"' for label in labels[1:])))
    return out


def schemas(subject: str) -> List[Dict[str, Any]]:
    """The two tool declarations, in the app's own words for what the
    project holds."""
    return [
        {'type': 'function', 'function': {
            'name': 'run_code',
            'description': ('Run Python over a plain-data view of the project, for a question the other '
                            'reads do not answer in one call: a loop over many documents, a join between '
                            'columns, a tally under your own conditions, a check across the corpus. Code '
                            f'sees {subject} through load(document), documents(), query(q) and plan(tool, '
                            '...), and nothing else: no filesystem, no network, no packages. Call code_help '
                            'first for the shape of a document and examples. Print what you want to see.'),
            'parameters': {'type': 'object', 'properties': {
                'code': {'type': 'string', 'description': 'The Python to run.'}},
                'required': ['code']}}},
        {'type': 'function', 'function': {
            'name': 'code_help',
            'description': ('What run_code can see and do: the functions available to the code, the '
                            'shape of a loaded document, the limits, and worked examples. Call it before '
                            'the first run_code of a conversation.'),
            'parameters': {'type': 'object', 'properties': {}, 'required': []}}},
    ]


def plan_proxy(ws, call_tool, write_tools) -> Callable[..., str]:
    """``plan(tool, **args)`` for the sandbox: one of the app's plan tools by
    name, through the app's own ``call_tool``, so every guard and every
    refusal applies exactly as it does when the model calls the tool."""
    def plan(tool: str, **args) -> str:
        if tool not in write_tools:
            return f'Error: "{tool}" is not a plan tool. One of: ' + ', '.join(sorted(write_tools))
        why = ws.garbled(args) if hasattr(ws, 'garbled') else None
        if why:
            return f'Error: {why}'
        return call_tool(ws, tool, args)
    return plan


def load_proxy(ws, view: Callable[[Any], Any]) -> Callable[[str], Any]:
    """``load(document)`` for the sandbox: one document as the app's plain-data
    view, addressed by id or name.

    A run that has asked for a second document is walking the corpus rather
    than asking about one, and every ``load`` after that would otherwise wait
    a whole round trip by itself. From there the rest of the document list is
    read in the background, a bounded few at a time, so the walk overlaps its
    reads instead of queueing them. A run that wanted one or two documents
    starts nothing extra, and a run that stops early takes the unstarted reads
    with it when the turn closes.
    """
    def load(document: str):
        try:
            doc = view(ws.doc(document))
        except ToolError as e:
            raise ValueError(str(e))
        if ws.reader.walking():
            ws.read_ahead(ws.documents(), once=True)
        return doc
    return load


def api(ws, view: Callable[[Any], Any], call_tool, write_tools,
        layer_index: Callable, display: Callable,
        view_of: Optional[Callable[[Any], Callable[[Any], Any]]] = None) -> Dict[str, Callable]:
    """The names the code runs against. An app supplies what only it knows:
    how one of its documents looks as plain data (``view``), its tool table,
    and how its layer names are read back from the project. ``view_of(ws)``
    is the view for another workspace, for an app whose view reads the
    project as well as the document; without it ``view`` serves every one.

    ``documents`` and ``query`` are the same wherever they are offered, so they
    are written here: three copies of the query wrapper is three places for the
    refusal to stop being turned into something the code can catch.

    In a turn that may read other projects, ``documents``, ``load`` and
    ``query`` each take ``project=`` as the read tools do, and ``plan`` hands
    it on to the plan tool, which refuses it (see core/reach.py).
    """
    from . import filetools
    from .query import QueryRefused, parse_query, rewrite, run as run_query
    from .reach import target
    loads: Dict[int, Callable[[str], Any]] = {}

    def workspace(project):
        try:
            return target(ws, project)
        except ToolError as e:
            raise ValueError(str(e))

    def documents(project=None):
        return [{'id': d['id'], 'name': d.get('name') or ''} for d in workspace(project).documents()]

    def load(document, project=None):
        # An entry of documents() is what a loop over it holds, and five of
        # the benchmark's failed calls handed one in.
        if isinstance(document, dict) and ('id' in document or 'name' in document):
            document = document.get('id') or document.get('name')
        w = workspace(project)
        if id(w) not in loads:
            loads[id(w)] = load_proxy(w, view_of(w) if view_of and w is not ws else view)
        return loads[id(w)](document)

    def query(q, project=None):
        w = workspace(project)
        try:
            parsed = parse_query(q)
            idx = layer_index(w)
            docs = {(d.get('name') or '').casefold(): d['id'] for d in w.documents()}
            return run_query(w.client, rewrite(parsed, idx, display(idx), docs), w.project.id)
        except (QueryRefused, ToolError) as e:
            raise ValueError(str(e))

    return {'documents': documents, 'load': load, 'query': query,
            'plan': plan_proxy(ws, call_tool, write_tools),
            **filetools.api(ws), **filetools.save_api(ws)}


# The host functions whose answers stage or store something rather than read
# the project, so are not text a value could be copied from.
_WRITERS = ('plan', 'save_file')


def noted(ws, api: Dict[str, Callable]) -> Dict[str, Callable]:
    """``api`` with every read's answer noted as text the code could copy a
    value from (see core.garble), which a document loaded in code and never
    printed is."""
    seen = getattr(ws, 'seen', None)
    if seen is None:
        return api

    from .filetools import READERS, made_file

    def wrap(name, f):
        def read(*args, **kwargs):
            answer = f(*args, **kwargs)
            # A file the assistant made vouches for nothing: what it holds may
            # have been typed.
            if name in READERS and made_file(ws, args[0] if args else kwargs.get('name')):
                return seen.add_made(answer)
            if name == 'files':
                mine = [r for r in answer if made_file(ws, r.get('name'))]
                seen.add_made(mine)
                seen.add([r for r in answer if r not in mine], unless=[args, kwargs])
                return answer
            return seen.add(answer, unless=[args, kwargs])
        return read
    return {name: (f if name in _WRITERS else wrap(name, f)) for name, f in api.items()}


def run_tool(ws, code: Optional[str], api: Callable[[Any], Dict[str, Callable]], shape: str = '') -> str:
    """The ``run_code`` tool, for every app. One worker per turn, opened on the
    first call and released by the workspace's ``close()``; ``api(ws)`` is what
    the app lets the code see, and ``shape`` its short example of a loaded
    document."""
    if getattr(ws, 'code', None) is None:
        ws.code = Session()
    try:
        return run(code, noted(ws, api(ws)), session=ws.code, shape=shape)
    except CodeError as e:
        raise ToolError(str(e))
