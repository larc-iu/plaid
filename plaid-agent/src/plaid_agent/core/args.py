"""Reading the arguments a model wrote.

A tool's arguments arrive from the model, so "20 or so" is as likely as 20.
Every refusal a tool makes is a sentence the model can act on, and `int()`
raising is the one that is not: it answers with a Python message about base 10
from a module whose whole contract is the opposite.
"""

from typing import Any


def clamp_limit(raw: Any, default: int, cap: int, name: str = 'limit') -> int:
    """``raw`` as an int in [1, cap], ``default`` when it is absent.

    Raises :class:`ValueError` with a readable sentence when it is not a
    number, which `call_tool` hands back to the model as the tool's answer.
    """
    if raw is None or raw == '':
        return default
    try:
        n = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f'"{name}" has to be a number, not {raw!r}.') from None
    return max(1, min(n, cap))
