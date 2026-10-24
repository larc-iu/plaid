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
rewritten where the pattern matches it as stored. A pattern that holds a
combining mark (a tone mark respelled on its own) is matched and rewritten in
the value decomposed, so it reaches the mark inside a composed letter, and the
value comes back composed, as the server stores it.
"""

import bisect
import unicodedata
from typing import Callable, List, Tuple

import regex

from .java_regex import PatternError, compile_decomposed, compile_pair, nfc, nfd


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


def _matches(compiled, s: str):
    """The matches of ``compiled`` in ``s`` as Java's ``find`` loop takes
    them: after an empty match the next search starts one place on, so no
    non-empty match is taken at the place of an empty one (``|a`` on ``a`` is
    one empty match, not an empty one and then ``a``, as Python's own
    iteration gives it). JS's replace moves on the same way."""
    pos = 0
    while pos <= len(s):
        m = compiled.search(s, pos)
        if m is None:
            return
        yield m
        pos = m.end() if m.end() > m.start() else m.end() + 1


def _sub(compiled, expand, s: str) -> str:
    """``compiled.sub(template, s)`` over :func:`_matches`, each match
    written as ``expand`` gives it."""
    out, last = [], 0
    for m in _matches(compiled, s):
        out.append(s[last:m.start()])
        try:
            out.append(expand(m))
        except IndexError:
            # As sub says it.
            raise regex.error('invalid group reference')
        last = m.end()
    out.append(s[last:])
    return ''.join(out)


def _group_hint(template: str) -> str:
    """How to write a group followed by a digit, where the template has one:
    "\\13NSG" is read as group 13 (bench, twice, meant group 1 then 3NSG)."""
    m = regex.search(r'\\(\d)(\d[^\\]*)', template)
    if not m:
        return ''
    n, rest = m.group(1), m.group(2)
    return f' Write \\g<{n}> for group {n} when a digit follows it, as in \\g<{n}>{rest}.'


def _is_upper(c: str) -> bool:
    return c != c.lower() and c == c.upper()


def _is_lower(c: str) -> bool:
    return c != c.upper() and c == c.lower()


def _has_capital(s: str) -> bool:
    return any(_is_upper(c) for c in s)


def match_case(matched: str, replacement: str) -> str:
    """The replacement for one match of an any-case search, in the matched
    text's capitals, as the app's own respelling writes it (its
    replacer.js, matchCase): "a" to "ä" makes "Ali" "Äli", and
    "ka" to "ga" makes "KALA" "GALA". A match whose cased letters are all
    capitals (two or more) takes the replacement in capitals, a match that
    starts with a capital takes it with its first small letter a capital,
    and any other match takes it as typed."""
    letters = [c for c in matched if _is_upper(c) or _is_lower(c)]
    if not letters or not replacement:
        return replacement
    if len(letters) > 1 and all(_is_upper(c) for c in letters):
        return replacement.upper()
    if not _is_upper(letters[0]):
        return replacement
    k = next((i for i, c in enumerate(replacement) if _is_lower(c)), -1)
    if k < 0 or _has_capital(replacement[:k]):
        return replacement
    return replacement[:k] + replacement[k].upper() + replacement[k + 1:]


#: A backslash escape in a pattern, whose letters name no case (``\W``, ``\p{Lu}``).
_ESCAPE = regex.compile(r'\\[pPN]\{[^}]*\}|\\.', regex.S)


def replacer(pattern: str, replacement: str, regex_mode: bool, whole: bool,
             case_sensitive: bool = False, error=None, keep_case: bool = False) -> Callable[[str], str]:
    """A function from a stored value to its replacement.

    Case-insensitive by default, like search, so what search found is what the
    replacement hits. A pattern that cannot be built raises ``error``, by
    default :class:`core.tools.ToolError` (``invalid-argument``), whose
    message reaches the model.

    With ``keep_case`` an any-case match writes the replacement in the
    match's capitals (:func:`match_case`), when neither the pattern nor the
    replacement is typed with a capital: "PFV" to "pfv" asks for those very
    capitals to go. A respelling asks for it, as the app's own does.
    """
    if error is None:
        from .tools import ToolError

        def error(message):
            return ToolError(message, kind='invalid-argument')
    if not pattern:
        raise error('Give a pattern.')
    replacement = '' if replacement is None else str(replacement)
    try:
        kw = dict(literal=not regex_mode, case_insensitive=not case_sensitive, whole=whole)
        compiled, composed = compile_pair(pattern, **kw)
        decomposed = compile_decomposed(pattern, **kw)
    except PatternError as e:
        raise error(f'That pattern cannot be used: {e}')
    # A literal replacement is text, not a template: every backslash in it
    # stands for itself.
    template = replacement if regex_mode else replacement.replace('\\', '\\\\')
    typed = [_ESCAPE.sub('', pattern), _ESCAPE.sub('', replacement)] if regex_mode else [pattern, replacement]
    cased = keep_case and not case_sensitive and not any(_has_capital(t) for t in typed)

    def expand(m) -> str:
        out = m.expand(template)
        return match_case(m.group(0), out) if cased else out

    def apply(value: str) -> str:
        try:
            if decomposed is not None:
                # A pattern holding a mark reads the value decomposed, so it
                # reaches a mark inside a composed letter too. The result is
                # composed, as the server stores every value.
                d = nfd(value)
                if decomposed.search(d) is not None:
                    return nfc(_sub(decomposed, expand, d))
            n = nfc(value)
            if composed.search(n) is None:
                # Only the text as stored matches (a mark on its own), or
                # nothing does.
                return _sub(compiled, expand, value)
            if n is value:
                return _sub(composed, expand, value)
            start, end = _mapper(value)
            out, last = [], 0
            for m in _matches(composed, n):
                a, b = max(start(m.start()), last), max(end(m.end()), last)
                out.append(value[last:a])
                out.append(expand(m))
                last = b
            out.append(value[last:])
            return ''.join(out)
        except (regex.error, IndexError) as e:
            raise error(f'The replacement is not valid for that pattern: {e}.{_group_hint(template)}')
    return apply
