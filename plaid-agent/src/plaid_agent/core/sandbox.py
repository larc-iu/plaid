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

import atexit
import threading
from typing import Any, Callable, Dict, List, Optional

OUTPUT_MAX = 12000                 # characters of output handed back, like every tool result
EXEC_SECONDS = 120.0               # interpreter time; time spent in host functions is not counted
WALL_SECONDS = 900.0               # the host-side backstop for one call, host functions included
MEMORY_BYTES = 1024 * 1024 * 1024
MAX_SUSPENSIONS = 500_000          # host calls one run may make: a walk over a large corpus is thousands
MODULES = ('re', 'json', 'math', 'collections', 'itertools', 'functools', 'datetime', 'unicodedata')

NAMES = ('run_code', 'code_help')


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
    exit. A checkout per call, so no state leaks from one run to the next."""
    with _lock:
        if _state['pool'] is None:
            from pydantic_monty import Monty
            pool = Monty(request_timeout=WALL_SECONDS)
            pool.__enter__()
            atexit.register(lambda: pool.__exit__(None, None, None))
            _state['pool'] = pool
        return _state['pool']


def _explain(e) -> str:
    """The sandbox's error, with a line about what the sandbox has where the
    error is about what it lacks."""
    text = e.display(format='traceback') if hasattr(e, 'display') else str(e)
    text = text.strip()
    if 'ModuleNotFoundError' in text:
        text += ('\nThe sandbox has these modules and no others: ' + ', '.join(MODULES)
                 + '. Everything about the project comes through documents(), load(), query() and plan().')
    return text


def run(code: str, api: Dict[str, Callable], on_progress: Optional[Callable[[str], None]] = None) -> str:
    """Run ``code`` with ``api`` as its host functions. Returns what it
    printed and the value of its last expression, capped. Raises
    :class:`CodeError` with the reason when it did not finish."""
    reason = available()
    if reason:
        raise CodeError(f'Code cannot run on this assistant: {reason}.')
    if not isinstance(code, str) or not code.strip():
        raise CodeError('Give code to run, as a string.')
    from pydantic_monty import CollectString, MontyCrashedError, MontyRuntimeError
    printed = CollectString(max_bytes=4 * 1024 * 1024)
    if on_progress:
        on_progress('Running code…')
    limits = {'max_duration_secs': EXEC_SECONDS, 'max_memory': MEMORY_BYTES,
              'max_suspensions': MAX_SUSPENSIONS}
    try:
        with _pool().checkout(limits=limits) as session:
            value = session.feed_run(code, external_lookup=dict(api), print_callback=printed)
    except MontyRuntimeError as e:
        raise CodeError(_explain(e) + _partial(printed))
    except MontyCrashedError as e:
        if getattr(e, 'timed_out', False):
            raise CodeError(f'The code ran for more than {WALL_SECONDS / 60:.0f} minutes and was stopped. '
                            f'Narrow it: fewer documents, or a query() for the counting.' + _partial(printed))
        raise CodeError('The sandbox stopped while running this code. Try again with less at once.'
                        + _partial(printed))
    out = printed.output
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
run_code runs Python you write, in a sandbox with no filesystem, no network and no packages: only the
standard-library modules {modules}. It is for a question the reads do not answer directly: a loop over
many documents, a join between two columns, a tally under your own conditions, a check across the corpus.
It is not for what a single tool already answers.

The project reaches the code through four functions, and nothing else:
  documents()                 -> [{{"id", "name"}}, ...] every document in the project
  load(document)              -> a plain-data view of one document (its shape is below); by id or name
  query(q)                    -> the engine's answer to a query object, as query_help describes it
                                 (layers by name; "results" holds the rows as plain dicts)
  plan(tool, **args)          -> stage a proposal through a plan tool by name, with the same arguments
                                 the tool takes; returns the tool's own reply as text. Nothing is written:
                                 the user approves the plan afterwards, exactly as with the tools.
Print what you want to see; the value of the last expression is returned too. Output is capped at
{output_max} characters, so summarize in the code rather than printing everything. One run may take up
to {exec_seconds:.0f} seconds of computation; loading a document is a call to the server and does not
count, but a walk over a very large corpus is slow, so use query() for counting where it can count.
Errors come back as text; fix the code and run again.
'''


def help_text(app_half: str) -> str:
    return HELP.format(modules=', '.join(MODULES), output_max=OUTPUT_MAX,
                       exec_seconds=EXEC_SECONDS) + app_half


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
                            '...), and nothing else: no files, no network, no packages. Call code_help '
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
        return call_tool(ws, tool, args)
    return plan
