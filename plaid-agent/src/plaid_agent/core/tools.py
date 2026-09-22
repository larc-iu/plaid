"""Building a tool table, and deciding which of it a turn may see.

Nothing here knows what an app annotates. What it knows is the SHAPE a tool
declaration has to have, and the one rule about offering tools: a capability
the operator did not configure is not mentioned at all, so a model is never
told it can look something up or run code when it cannot.
"""

import inspect
import traceback
from typing import Any, Callable, Dict, List, Optional

from .args import clamp_limit, read_int, sentence_number, sentence_numbers
from .limits import MAX_RESULT_CHARS, MAX_SENTENCES_PER_READ, READ_LIMITS, RENDER_BUDGET


class ToolError(Exception):
    """A tool-level failure whose message goes back to the model as the result.

    One class, not one per app: the workspace and the corpus helper both raise
    it from shared code, and an app that caught only its own would let those
    through as a traceback instead of as a sentence the model can act on.
    """


def truncate(s: str) -> str:
    """One tool result, cut to what a turn can carry, saying what was cut and
    what to do about it. Every tool answer goes through this."""
    if len(s) <= MAX_RESULT_CHARS:
        return s
    return s[:MAX_RESULT_CHARS] + (f'\n... [truncated: {len(s) - MAX_RESULT_CHARS} more characters; '
                                   f'narrow the request]')


def server_refused(what: str, e: Exception) -> ToolError:
    """A read the server would not answer, said as one sentence.

    The exception's own text carries the server's reason, which is worth
    keeping, but it also carries a URL, a Python repr, and sometimes several
    lines of them. Bounded to one line here, so every "could not be read" in
    either app reads the same and none of them hands the model a traceback.
    """
    reason = ' '.join(str(e).split())[:200]
    return ToolError(f'{what} could not be read' + (f': {reason}' if reason else '.'))


def run_tool(ws, name: str, fn_: Callable, args: Optional[Dict[str, Any]],
             after: Optional[Callable[[str], str]] = None) -> str:
    """Run one tool and answer with text, whatever happens.

    Every failure reaches the model as a sentence in the tools' own
    vocabulary. Python's is never part of one: an argument the tool does not
    take is answered with the tool's NAME and its parameter names (the
    binding error says the internal function's name and Python's word for the
    problem), and an unexpected failure is answered by saying so, with the
    traceback going to the operator's log where it is of use.

    ``after`` is what the app appends to a successful answer.
    """
    ws.forget_clipping()
    try:
        bound = inspect.signature(fn_).bind(ws, **(args or {}))
    except TypeError:
        params = [p for p in inspect.signature(fn_).parameters if p != 'ws']
        return (f'Error: {name} cannot be called with those arguments. It takes: '
                + ', '.join(params) + '.')
    try:
        out = truncate(fn_(*bound.args, **bound.kwargs))
        return after(out) if after else out
    except (ToolError, ValueError) as e:  # ValueError: a name or reference lookup failed
        return f'Error: {e}'
    except Exception:  # noqa: BLE001 - the model gets a sentence; the log gets the trace
        traceback.print_exc()
        return (f'Error: {name} failed, which is a fault in the tool rather than in the request. '
                'Tell the user, and try another way of asking rather than the same call again.')


def fn(name: str, description: str, properties: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    """One tool declaration, in the shape every provider takes."""
    return {'type': 'function', 'function': {
        'name': name, 'description': description,
        'parameters': {'type': 'object', 'properties': properties, 'required': required}}}


def limit_arg(tool: str, what: str = 'Rows') -> Dict[str, Any]:
    """The ``limit`` parameter of a read both apps offer, with the numbers the
    tool really uses.

    Written out by hand it was a third copy of :data:`core.limits.READ_LIMITS`
    (the table, the signature's own default, and this sentence), and the three
    disagreed: a schema said 30 where the tool answered with a hundred rows.
    """
    default, cap = READ_LIMITS[tool]
    return {'type': 'integer', 'description': f'{what} (default {default}, max {cap}).'}


def tools_for(ws, tools: List[Dict[str, Any]], web_tools, code_tools,
              file_tools=()) -> List[Dict[str, Any]]:
    """The tools a turn on this workspace may call.

    The web tools exist only where the operator configured a search backend,
    the code tools only where the sandbox's worker binary is installed, and the
    file tools only where the user has actually attached something, so a model
    that cannot do any of the three is never told that it can.
    """
    from . import sandbox
    hidden = set() if ws.web is not None else set(web_tools)
    if sandbox.available() is not None:
        hidden |= set(code_tools)
    if not getattr(ws, 'files', None):
        hidden |= set(file_tools)
    return [t for t in tools if t['function']['name'] not in hidden]


def list_documents(ws, pattern: str = None, limit: int = None, offset: int = 0) -> str:
    """The project's documents by name, a page at a time, narrowed by a
    substring. Every app lists them the same way, because a document is a
    document whatever an app puts in one."""
    docs = ws.documents()
    if pattern:
        docs = [d for d in docs if pattern.lower() in (d.get('name') or '').lower()]
    if not docs:
        return 'No documents matched.' if pattern else 'The project has no documents.'
    limit = clamp_limit(limit, *READ_LIMITS['list_documents'])
    offset = read_int(offset, 'offset', 0, minimum=0)
    page = docs[offset:offset + limit]
    out = [f'{len(docs)} document(s)' + (f' matching "{pattern}"' if pattern else '')
           + (f', showing {offset + 1} to {offset + len(page)}' if len(docs) > len(page) else '')
           + ':']
    for d in page:
        out.append(f'  "{d.get("name")}"')
    return '\n'.join(out)


def read_document(ws, document: str = None, from_sentence=None, to_sentence=None,
                  sentences=None) -> str:
    """One document, a page of sentences at a time, or the sentences named.

    Named sentences beat a range: a reader that already knows where to look
    should not have to page a long document to get there. How a sentence is
    RENDERED is the app's (:meth:`BaseWorkspace.render`); which ones, and how
    many at once, is not.
    """
    doc = ws.doc(document)
    if sentences:
        picked = sentence_numbers(sentences)[:MAX_SENTENCES_PER_READ]
        return truncate(ws.render(doc, indexes=picked, budget=RENDER_BUDGET))
    lo = max(1, sentence_number(from_sentence, 'from_sentence') or 1)
    hi = (sentence_number(to_sentence, 'to_sentence')
          or min(len(doc.sentences), lo + MAX_SENTENCES_PER_READ - 1))
    if hi - lo + 1 > MAX_SENTENCES_PER_READ:
        hi = lo + MAX_SENTENCES_PER_READ - 1
    return truncate(ws.render(doc, from_sentence=lo, to_sentence=hi, budget=RENDER_BUDGET))
