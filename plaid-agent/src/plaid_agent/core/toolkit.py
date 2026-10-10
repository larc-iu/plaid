"""The half of an app's tool table every app has: the shared tools' schemas,
and the tail every toolkit ends with.

An app declares its own tools beside their implementations. What it does not
write again is the wording of a tool every app offers (the history, the
comments, the plan so far, the query language), the tools core implements
outright (the guidelines, the web, attached files, the sandbox), and the
dispatch behind them. So the model reads one description of each shared tool
whichever assistant it is.
"""

from typing import Any, Callable, Dict, List, NamedTuple, Optional

from . import filetools, guidelines, sandbox, webtools
from .reach import route
from .tools import ToolError, fn, limit_arg, run_tool, tools_for as offered_tools

_DOC = {'type': 'string', 'description': 'Document id or exact name (see project_overview).'}


def shared_schemas(*, ref: str, comment_field: bool = False, restore: bool = False) -> Dict[str, Dict[str, Any]]:
    """The schemas of the shared tools, by name, for an app to place in its
    table. ``ref`` describes what a comment's ``ref`` names in this app,
    ``comment_field`` says whether a comment may sit on one value of it, and
    ``restore`` whether the app offers restore_document, which takes the
    instant recent_changes prints."""
    comment_props: Dict[str, Any] = {'document': _DOC, 'ref': {'type': 'string', 'description': ref}}
    on = 'document + ref'
    if comment_field:
        comment_props['field'] = {'type': 'string',
                                  'description': 'A field of the thing ref names, for the comments on its value.'}
        on += ', plus field for a comment on one of its values'
    comment_props['limit'] = limit_arg('comments', 'Newest entries to show')
    return {
        'list_documents': fn(
            'list_documents',
            'The documents by name, a page at a time, optionally filtered by a name substring.',
            {'pattern': {'type': 'string'}, 'limit': limit_arg('list_documents', 'Documents to show'),
             'offset': {'type': 'integer'}}, []),
        'recent_changes': fn(
            'recent_changes',
            'Who changed what, when, and under which operation label, the plans this assistant applied '
            'among them.' + (' Each entry ends with as_of=<instant>, the moment right after that change, '
                             'which restore_document takes.' if restore else ''),
            {'document': _DOC, 'limit': limit_arg('recent_changes', 'Entries to show'),
             'since': {'type': 'string', 'description': 'Only changes at or after this date (YYYY-MM-DD) or '
                                                        'timestamp.'},
             'user': {'type': 'string', 'description': 'Only changes by this person (name or email substring).'}},
            []),
        'comments': fn(
            'comments',
            'What people have written to each other: in the whole project (no document), in one document, '
            f'or on one thing in it ({on}). These are notes between annotators, never annotation. Oldest first.',
            comment_props, []),
        'plan_status': fn('plan_status', 'Every change planned so far in this turn, numbered.', {}, []),
        'discard_plan': fn('discard_plan', 'Throw away everything planned so far and start the plan over.', {}, []),
        'drop_planned': fn(
            'drop_planned', 'Drop some of the planned changes by their numbers from plan_status. The rest stay.',
            {'indexes': {'type': 'array', 'items': {'type': 'integer'}}}, ['indexes']),
        'query_help': fn(
            'query_help',
            'The Plaid query language that `query` takes, and this project\'s layer names. Call it once before '
            'writing a query.', {}, []),
        'query': fn(
            'query',
            'Run one read-only Plaid query over this project: structure across layers, joins, negation, '
            'aggregates. The escape hatch for a question the other tools cannot express, so prefer them when '
            'they fit. Layers are named by their names from query_help.',
            {'query': {'type': 'object', 'description': 'The query object: find, where, return, limit, '
                                                        'order_by. See query_help.'},
             'limit': limit_arg('query', 'Rows to show')},
            ['query']),
    }


class Kit(NamedTuple):
    tools: List[Dict[str, Any]]
    write_tools: frozenset
    tools_for: Callable
    call_tool: Callable


def build(tools: List[Dict[str, Any]], impl: Dict[str, Callable], *, manual: str, web: str, code: str,
          rewrite: Optional[Callable[[Callable, Dict[str, Any]], Dict[str, Any]]] = None) -> Kit:
    """An app's whole tool table and the dispatch behind it, from the tools it
    declares. Core's own tools are added in one order for every app: the
    guidelines (``manual`` says what they are about), the web (``web`` what
    to look up), attached files, the sandbox (``code`` what it reads; its
    implementations are the app's, in ``impl``). ``impl`` gains core's.

    ``rewrite(fn, args)`` is the app's last word on a call's arguments before
    the tool runs."""
    tools = (list(tools) + guidelines.schemas(manual) + guidelines.write_schemas() + webtools.schemas(web)
             + filetools.schemas() + sandbox.schemas(code))
    impl.update({'read_guideline': guidelines.t_read_guideline, 'add_guideline': guidelines.t_add_guideline,
                 'revise_guideline': guidelines.t_revise_guideline,
                 'rewrite_guideline': guidelines.t_rewrite_guideline,
                 'web_search': webtools.t_web_search, 'read_url': webtools.t_read_url,
                 'read_file': filetools.t_read_file})
    # A tool that plans a change says so in the first word of its description,
    # and that is what makes it one: no second list to keep in step.
    write = frozenset(t['function']['name'] for t in tools if t['function']['description'].startswith('PLAN:'))

    def tools_for(ws) -> List[Dict[str, Any]]:
        """The tools a turn on this workspace may call."""
        return offered_tools(ws, tools, webtools.NAMES, sandbox.NAMES, filetools.NAMES)

    def call_tool(ws, name: str, args: Dict[str, Any]) -> str:
        """Run one tool. Every failure comes back as text for the model."""
        f = impl.get(name)
        if not f:
            return f'Error: there is no tool named {name}.'
        # The project the call names, in a turn that may read several: its own
        # workspace, and the arguments without the name (see core/reach.py).
        try:
            ws, args = route(ws, name, args)
        except ToolError as e:
            return f'Error: {e}'
        # A change this turn planned over one an earlier call planned is worth
        # a sentence: the model asked for two and is getting one. Said here
        # rather than in each tool, so a tool cannot be written without it.
        after = (lambda out: out + ws.superseded_note()) if name in write else None
        return run_tool(ws, name, f, rewrite(f, args) if rewrite else args, after=after)

    return Kit(tools, write, tools_for, call_tool)
