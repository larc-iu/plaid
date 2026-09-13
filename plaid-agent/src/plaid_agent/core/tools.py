"""Building a tool table, and deciding which of it a turn may see.

Nothing here knows what an app annotates. What it knows is the SHAPE a tool
declaration has to have, and the one rule about offering tools: a capability
the operator did not configure is not mentioned at all, so a model is never
told it can look something up or run code when it cannot.
"""

from typing import Any, Dict, List


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
