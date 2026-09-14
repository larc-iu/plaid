"""Building a tool table, and deciding which of it a turn may see.

Nothing here knows what an app annotates. What it knows is the SHAPE a tool
declaration has to have, and the one rule about offering tools: a capability
the operator did not configure is not mentioned at all, so a model is never
told it can look something up or run code when it cannot.
"""

from typing import Any, Dict, List

from .limits import MAX_RESULT_CHARS


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


def fn(name: str, description: str, properties: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    """One tool declaration, in the shape every provider takes."""
    return {'type': 'function', 'function': {
        'name': name, 'description': description,
        'parameters': {'type': 'object', 'properties': properties, 'required': required}}}


def tools_for(ws, tools: List[Dict[str, Any]], web_tools, code_tools) -> List[Dict[str, Any]]:
    """The tools a turn on this workspace may call.

    The web tools exist only where the operator configured a search backend,
    and the code tools only where the sandbox's worker binary is installed, so
    a model that cannot do either is never told that it can.
    """
    from . import sandbox
    hidden = set() if ws.web is not None else set(web_tools)
    if sandbox.available() is not None:
        hidden |= set(code_tools)
    return [t for t in tools if t['function']['name'] not in hidden]
