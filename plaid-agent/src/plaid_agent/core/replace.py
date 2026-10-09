"""One substitution, built from what a model wrote.

Both apps offer a find-and-replace over stored values, and both take the same
four switches: literal or regular expression, the whole value or a substring,
case-sensitive or not. The values to rewrite are found by the server's search,
so the pattern is read here exactly as the server reads it
(:mod:`.java_regex`): Python's own ``re`` read ``\\w``, ``\\b`` and
``[[:alpha:]]`` otherwise, and a replace rewrote other values than the search
found.

The other subtlety is the literal replacement, the one a person asks for: a
replacement typed as text goes into ``sub`` as a TEMPLATE, where a backslash
means something. So "back\\slash" raised, "x\\1y" raised, and neither is a
pattern the user was writing.

Anchoring is the next half: ``whole`` anchors the PATTERN rather than
switching to ``fullmatch``, so a group captured in a whole-value pattern can
still be written back into the replacement.

And a value matches as the server's search finds it, as stored or in NFC
with the pattern in NFC (:func:`.java_regex.matcher`): a pattern typed
composed finds ``pʰá`` stored decomposed. A match in the composed text is
mapped back onto the value as stored, code point for code point, and only
that place is rewritten, with the replacement as typed. The rest of the value
keeps its own spelling. A value whose composed text holds no match is
rewritten where the pattern matches it as stored (a combining mark replaced
on its own, a tone mark respelled).
"""

import bisect
import unicodedata
from typing import Callable, List, Tuple

import regex

from .java_regex import PatternError, compile_pair, nfc


def _pieces(s: str) -> List[Tuple[str, str]]:
    """``s`` cut where NFC changes nothing across the cut, each piece with
    its NFC form, so the NFC forms joined are NFC(``s``). A piece is a
    starter and the marks after it, joined to the one before when the two
    compose together (Hangul jamo, a mark reordered across)."""
    out: List[List[str]] = []
    at = 0
    for i in range(1, len(s) + 1):
        if i < len(s) and unicodedata.combining(s[i]):
            continue
        piece = s[at:i]
        at = i
        if out and nfc(out[-1][0] + piece) != out[-1][1] + nfc(piece):
            out[-1][0] += piece
            out[-1][1] = nfc(out[-1][0])
        else:
            out.append([piece, nfc(piece)])
    if ''.join(n for _, n in out) != nfc(s):
        return [(s, nfc(s))]
    return [(a, b) for a, b in out]


def _mapper(s: str):
    """(start, end): an offset into NFC(``s``) as the offset into ``s`` it
    stands for, as a match's start and as its end. An offset inside a piece
    NFC rewrote widens the match to the whole piece."""
    pieces = _pieces(s)
    stored, normal = [], []
    a = b = 0
    for piece, n in pieces:
        stored.append(a)
        normal.append(b)
        a += len(piece)
        b += len(n)

    def at(x: int, end: bool) -> int:
        if x >= b:
            return len(s)
        k = bisect.bisect_right(normal, x) - 1
        off = x - normal[k]
        piece, n = pieces[k]
        if off == 0 or piece == n:
            return stored[k] + off
        return stored[k] + (len(piece) if end else 0)
    return (lambda x: at(x, False)), (lambda x: at(x, True))


def replacer(pattern: str, replacement: str, regex_mode: bool, whole: bool,
             case_sensitive: bool = False, error=ValueError) -> Callable[[str], str]:
    """A function from a stored value to its replacement.

    Case-insensitive by default, like search, so what search found is what the
    replacement hits. ``error`` is the exception class the app reports to the
    model with; the message is the whole of what it says.
    """
    if not pattern:
        raise error('Give a pattern.')
    replacement = '' if replacement is None else str(replacement)
    try:
        compiled, composed = compile_pair(pattern, literal=not regex_mode,
                                          case_insensitive=not case_sensitive, whole=whole)
    except PatternError as e:
        raise error(f'That pattern cannot be used: {e}')
    # A literal replacement is text, not a template: every backslash in it
    # stands for itself.
    template = replacement if regex_mode else replacement.replace('\\', '\\\\')

    def apply(value: str) -> str:
        try:
            n = nfc(value)
            if composed.search(n) is None:
                # Only the text as stored matches (a mark on its own), or
                # nothing does.
                return compiled.sub(template, value)
            if n is value:
                return composed.sub(template, value)
            start, end = _mapper(value)
            out, last = [], 0
            for m in composed.finditer(n):
                a, b = max(start(m.start()), last), max(end(m.end()), last)
                out.append(value[last:a])
                out.append(m.expand(template))
                last = b
            out.append(value[last:])
            return ''.join(out)
        except (regex.error, IndexError) as e:
            raise error(f'The replacement is not valid for that pattern: {e}')
    return apply
