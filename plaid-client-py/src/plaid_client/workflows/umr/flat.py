"""A graph a model wrote flat, joined back into one.

Asked for one PENMAN graph, a language model often writes one block per node
and links the blocks by bare variables::

    (h / have-01 :ARG0 e :ARG1 g)
    (e / person)
    (g / goat :color "white")

That is one graph in another layout, not three. The reader stops at the end
of the first block ("Unexpected content after the topmost closing bracket"),
and keeping the first block alone would leave ``e`` and ``g`` dangling.

The owner's ruling (umr-draft-unreadable-replies): each extra block whose
variable an earlier block uses is joined in where it is first used, with no
extra model call. A block nothing before it uses is not joined, so the reply is
still refused, as are undefined variables and unknown relations, which the
reader and the draft's own check go on catching after the join.

The join is done on the text, and the result goes through the one reader like
any other graph, so a join can never produce a graph the reader would not
accept from a person.
"""

import re
import unicodedata
from typing import List, Optional, Tuple

from .penman import _mask_literals, variable_from

#: The variable a block defines at its head: ``(h / have-01`` gives ``h``.
_HEAD = re.compile(r'\(\s*([^\s():#/]+)\s*/')


def top_level_blocks(text: str) -> Optional[List[Tuple[int, int]]]:
    """The ``(start, end)`` of each bracketed block at the top level of
    ``text``, in order, or None when the text is not a plain run of blocks:
    brackets that do not balance, or anything but whitespace and comments
    between blocks. Strings and comments are masked first, so a bracket inside
    either counts for nothing."""
    masked = _mask_literals(text)
    blocks: List[Tuple[int, int]] = []
    depth = 0
    start = 0
    for i, ch in enumerate(masked):
        if ch == '(':
            if depth == 0:
                start = i
            depth += 1
        elif ch == ')':
            if depth == 0:
                return None
            depth -= 1
            if depth == 0:
                blocks.append((start, i + 1))
        elif depth == 0 and not ch.isspace():
            return None
    return blocks if depth == 0 else None


def _head_variable(block: str) -> Optional[str]:
    m = _HEAD.match(_mask_literals(block))
    return variable_from(m.group(1)) if m else None


def _defined(text: str) -> set:
    return {variable_from(m.group(1)) for m in _HEAD.finditer(_mask_literals(text))}


def _first_use(text: str, variable: str) -> Optional[Tuple[int, int]]:
    """Where ``variable`` first stands as a value, ``:role variable``, in
    ``text``: the span of the variable itself. Strings and comments are masked,
    and the role must start a token, so ``:time 15:30`` holds no role ``:30``."""
    pattern = re.compile(r'(?<![^\s(]):[-A-Za-z0-9]+\s+(' + re.escape(variable)
                         + r')(?![^\s()#])')
    m = pattern.search(_mask_literals(text))
    return (m.start(1), m.end(1)) if m else None


def join_flat_graph(text: str) -> str:
    """``text`` with every extra top-level block joined in at the first use
    of its variable, in the order the blocks were written.

    A block is joined only when a block already joined uses its variable and
    does not define it itself. A block that cannot be joined is kept after the
    joined graph, where the reader refuses it as it always has. Text that is
    one graph, or not a run of blocks at all, comes back as it was."""
    source = unicodedata.normalize('NFC', text) if isinstance(text, str) else ''
    blocks = top_level_blocks(source)
    if not blocks or len(blocks) < 2:
        return text
    pieces = [source[start:end] for start, end in blocks]
    joined = pieces[0]
    left: List[str] = []
    for piece in pieces[1:]:
        variable = _head_variable(piece)
        site = None
        if variable and variable not in _defined(joined):
            site = _first_use(joined, variable)
        if site is None:
            left.append(piece)
            continue
        joined = joined[:site[0]] + piece + joined[site[1]:]
    if len(left) == len(pieces) - 1:
        return text
    return '\n'.join([joined, *left])
