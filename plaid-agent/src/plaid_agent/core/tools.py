"""Building a tool table, and deciding which of it a turn may see.

Nothing here knows what an app annotates. What it knows is the SHAPE a tool
declaration has to have, and the one rule about offering tools: a capability
the operator did not configure is not mentioned at all, so a model is never
told it can look something up or run code when it cannot.
"""

import inspect
import traceback
from typing import Any, Callable, Dict, List, Optional

from .args import clamp_limit, read_int, sentence_number
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
        return planned_where(ws, name, after(out) if after else out)
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
    offered = [t for t in tools if t['function']['name'] not in hidden]
    reach = getattr(ws, 'reach', None)
    if reach is None or not reach.others:
        return offered
    # The plan tools of this turn, which route() refuses for another project
    # before they run and run_tool() answers for with the project they
    # planned in.
    reach.writers = frozenset(t['function']['name'] for t in offered if plans(t))
    return [with_project(t, reach, plan=plans(t))
            if plans(t) or reads_a_project(t, web_tools, code_tools, file_tools) else t
            for t in offered]


def plans(tool: Dict[str, Any]) -> bool:
    """Whether a tool stages a change: its description says so in its first
    word, which is what makes it a plan tool in every app."""
    return tool['function']['description'].startswith('PLAN:')


def reads_a_project(tool: Dict[str, Any], *local) -> bool:
    """Whether a tool reads the project it is handed, and so takes ``project``
    in a turn that may read several. Not a plan tool (:func:`plans` decides
    those), not a tool that acts on the plan, not a reference text, and not
    one that reads the web, the attached files or runs code, which are the
    turn's rather than a project's."""
    from .reach import PLAN_TOOLS
    name = tool['function']['name']
    if plans(tool) or name in PLAN_TOOLS or name.endswith('_help'):
        return False
    return not any(name in names for names in local)


def with_project(tool: Dict[str, Any], reach, plan: bool = False) -> Dict[str, Any]:
    """A copy of ``tool`` that also takes ``project``: one of the projects this
    turn may read, named as :meth:`core.reach.Reach.labels` names them.

    A plan tool takes it too. Without it, a change the model meant for
    another project went to the home project whenever a field of that name
    was there as well, and nothing said so. Named, the change for another
    project is refused as read-only (see :func:`core.reach.route`)."""
    labels = reach.labels()
    f = tool['function']
    params = f['parameters']
    what = (f'Which project the change is for. Changes are planned in "{labels[0]}" only. Leave it out '
            f'for "{labels[0]}".' if plan else
            f'Which project to read. Leave it out for "{labels[0]}".')
    prop = {'type': 'string', 'enum': labels, 'description': what}
    return {**tool, 'function': {**f, 'parameters': {
        **params, 'properties': {**params.get('properties', {}), 'project': prop}}}}


def planned_where(ws, name: str, out: str) -> str:
    """A plan tool's answer in a turn that reads other projects, headed with
    the project it planned in. The model reads several projects in such a
    turn, and a result that named none let it tell the user a change was
    planned in the project it had just read when it was planned at home."""
    reach = getattr(ws, 'reach', None)
    if reach is None or not reach.others or name not in getattr(reach, 'writers', ()):
        return out
    return f'Project "{reach.labels()[0]}" (changes are planned here only):\n{out}'


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

    def position(item, name):
        if item is None or item == '':
            return None
        n = ws.sentence_position(doc, item)
        return n if n is not None else sentence_number(item, name)

    if sentences:
        items = sentences if isinstance(sentences, list) else [sentences]
        picked = list(dict.fromkeys(n for n in (position(i, 'sentences') for i in items)
                                    if n is not None))[:MAX_SENTENCES_PER_READ]
        return truncate(ws.render(doc, indexes=picked, budget=RENDER_BUDGET))
    lo = max(1, position(from_sentence, 'from_sentence') or 1)
    hi = (position(to_sentence, 'to_sentence')
          or min(len(doc.sentences), lo + MAX_SENTENCES_PER_READ - 1))
    if hi - lo + 1 > MAX_SENTENCES_PER_READ:
        hi = lo + MAX_SENTENCES_PER_READ - 1
    return truncate(ws.render(doc, from_sentence=lo, to_sentence=hi, budget=RENDER_BUDGET))
