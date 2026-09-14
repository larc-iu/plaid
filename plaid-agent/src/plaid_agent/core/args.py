"""Reading the arguments a model wrote.

A tool's arguments arrive from the model, so "20 or so" is as likely as 20.
Every refusal a tool makes is a sentence the model can act on, and `int()`
raising is the one that is not: it answers with a Python message about base 10
from a module whose whole contract is the opposite.

So no tool calls `int()` on an argument. It calls one of these, which say what
was wrong in the same voice as every other refusal.
"""

import re
from typing import Any, Optional


def whole(i) -> int:
    """One plan index. A fraction is refused rather than truncated: 1.5 is not
    change 1, and silently dropping change 1 for it is worse than a refusal."""
    if isinstance(i, bool):
        raise ValueError(i)
    if isinstance(i, int):
        return i
    if isinstance(i, float):
        if not i.is_integer():
            raise ValueError(i)
        return int(i)
    if re.fullmatch(r'-?[0-9]+', str(i).strip()):
        return int(str(i).strip())
    raise ValueError(i)


def clamp_limit(raw: Any, default: int, cap: int, name: str = 'limit') -> int:
    """``raw`` as an int in [1, cap], ``default`` when it is absent.

    Raises :class:`ValueError` with a readable sentence when it is not a
    number, which `call_tool` hands back to the model as the tool's answer.
    """
    return read_int(raw, name, default, minimum=1, maximum=cap)


def read_int(raw: Any, name: str, default: Optional[int] = None,
             minimum: Optional[int] = None, maximum: Optional[int] = None) -> Any:
    """``raw`` as an int, ``default`` when it is absent, clamped into
    ``[minimum, maximum]`` where those are given.

    The sibling of :func:`clamp_limit` for a number with no cap of its own: a
    position, an offset, a count the tool bounds for itself. Raises
    :class:`ValueError` with a readable sentence when it is not a number.
    """
    if raw is None or raw == '':
        return default
    if isinstance(raw, bool):  # True would otherwise read as 1
        raise ValueError(f'"{name}" has to be a number, not {raw!r}.')
    try:
        n = int(raw)
    except (TypeError, ValueError):
        raise ValueError(f'"{name}" has to be a number, not {raw!r}.') from None
    if minimum is not None:
        n = max(minimum, n)
    if maximum is not None:
        n = min(maximum, n)
    return n


def sentence_number(raw: Any, name: str = 'sentence') -> Optional[int]:
    """A sentence number written any way a read prints it: ``34``, ``"34"``,
    ``"s34"``, or ``"s34.w2"`` (the word's sentence).

    The model reads references out of a rendered document and writes them
    back, so a number argument is as likely to arrive as "s34". Raises
    :class:`ValueError` with a readable sentence for anything else.
    """
    if raw is None or raw == '':
        return None
    if isinstance(raw, bool):
        raise ValueError(f'"{raw}" does not name a sentence. Use a number or a reference like "s34".')
    if isinstance(raw, int):
        return raw
    first = str(raw).strip().split('.')[0]
    if first[:1].lower() == 's':
        first = first[1:]
    if not first.isdigit():
        raise ValueError(f'"{raw}" does not name a sentence. Use a number or a reference like "s34".')
    return int(first)
