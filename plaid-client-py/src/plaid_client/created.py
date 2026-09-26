"""The ids a create answered with.

A create's response is ``{"id": ...}`` and a bulk create's is ``{"ids": [...]}``,
read straight off the call or off its result in a batch (``{"status", "body"}``).
Every reader of a create response goes through these, so none guesses at the
shape.
"""

from typing import Any, Optional


def created_id(result: Any) -> Optional[str]:
    """The id a single create answered with, or None when it gave none."""
    if isinstance(result, dict):
        if isinstance(result.get("id"), str):
            return result["id"]
        body = result.get("body")
        if isinstance(body, dict) and isinstance(body.get("id"), str):
            return body["id"]
    return None


def created_ids(result: Any) -> list:
    """The ids a bulk create answered with, in input order, or an empty list
    when it gave none."""
    if isinstance(result, dict):
        if isinstance(result.get("ids"), list):
            return result["ids"]
        body = result.get("body")
        if isinstance(body, dict) and isinstance(body.get("ids"), list):
            return body["ids"]
    return []
