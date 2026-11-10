"""One substitution, built from what a model wrote.

Both apps offer a find-and-replace over stored values, and both take the same
four switches: literal or regular expression, the whole value or a substring,
case-sensitive or not. The values to rewrite are found by the server's search,
so the pattern is read here exactly as the server reads it
(:mod:`.java_regex`): Python's own ``re`` read ``\\w``, ``\\b`` and
``[[:alpha:]]`` otherwise, and a replace rewrote other values than the search
found.

The replacement reads as the app's own find-and-replace reads it, the two
held to one table of cases (tests/test_replace_template.py): a regex
replacement reads $1 to $99, $<name>, $&, $$, $` and $' as JavaScript's
``String.replace`` does (:func:`expand`), and a backslash in it is refused,
as the app refuses one. A plain replacement is text, $ and backslash
included.

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
        out.append(expand(m))
        last = m.end()
    out.append(s[last:])
    return ''.join(out)


#: What a tool that takes a replacement says of it to the model.
REPLACEMENT_HELP = 'With regex, $1 is the first group and $& the whole match. A backslash is refused.'

_DIGITS = '0123456789'


def expand(template: str, m) -> str:
    """``template`` for match ``m`` as JavaScript's ``String.replace`` writes
    it (GetSubstitution): ``$$`` a dollar, ``$&`` the match, ``$``` and
    ``$'`` the text before and after it, ``$nn`` group nn when the pattern
    has that many groups, else ``$n`` group n and the second digit as
    itself, ``$<name>`` the named group (empty when no group has that name)
    when the pattern names a group. A group that took no part is empty, and
    every other ``$`` is itself."""
    groups = m.re.groups
    named = bool(m.re.groupindex)
    out, i, n = [], 0, len(template)
    while i < n:
        c = template[i]
        nxt = template[i + 1] if i + 1 < n else ''
        if c != '$' or not nxt:
            out.append(c)
            i += 1
        elif nxt == '$':
            out.append('$')
            i += 2
        elif nxt == '&':
            out.append(m.group(0))
            i += 2
        elif nxt == '`':
            out.append(m.string[:m.start()])
            i += 2
        elif nxt == "'":
            out.append(m.string[m.end():])
            i += 2
        elif nxt in _DIGITS:
            two = template[i + 1:i + 3]
            if len(two) == 2 and two[1] in _DIGITS and 1 <= int(two) <= groups:
                out.append(m.group(int(two)) or '')
                i += 3
            elif 1 <= int(nxt) <= groups:
                out.append(m.group(int(nxt)) or '')
                i += 2
            else:
                out.append('$')
                i += 1
        elif nxt == '<' and named and template.find('>', i + 2) >= 0:
            close = template.find('>', i + 2)
            out.append(m.groupdict().get(template[i + 2:close]) or '')
            i = close + 1
        else:
            out.append('$')
            i += 1
    return ''.join(out)


def _backslash_refusal(replacement: str) -> str:
    """The app's refusal of a backslash in a regex replacement, said to the
    model. ``\\1`` is a group in sed, Perl and Python, so a backslash
    before a digit is told the group as this replacement writes it."""
    group = regex.search(r'\\([0-9])', replacement)
    hint = f' Write ${group.group(1)} for a group.' if group else ''
    return 'A regex replacement cannot hold a backslash. Type the character itself.' + hint


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
    replacement hits. A pattern that cannot be built, or a regex replacement
    that holds a backslash, raises ``error``, by
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
    if regex_mode and '\\' in replacement:
        raise error(_backslash_refusal(replacement))
    # A plain replacement is text: `$` and a backslash stand for themselves.
    typed = [_ESCAPE.sub('', pattern), replacement] if regex_mode else [pattern, replacement]
    cased = keep_case and not case_sensitive and not any(_has_capital(t) for t in typed)

    def write(m) -> str:
        out = expand(replacement, m) if regex_mode else replacement
        return match_case(m.group(0), out) if cased else out

    def apply(value: str) -> str:
        if decomposed is not None:
            # A pattern holding a mark reads the value decomposed, so it
            # reaches a mark inside a composed letter too. The result is
            # composed, as the server stores every value.
            d = nfd(value)
            if decomposed.search(d) is not None:
                return nfc(_sub(decomposed, write, d))
        n = nfc(value)
        if composed.search(n) is None:
            # Only the text as stored matches (a mark on its own), or
            # nothing does.
            return _sub(compiled, write, value)
        if n is value:
            return _sub(composed, write, value)
        start, end = _mapper(value)
        out, last = [], 0
        for m in _matches(composed, n):
            a, b = max(start(m.start()), last), max(end(m.end()), last)
            out.append(value[last:a])
            out.append(write(m))
            last = b
        out.append(value[last:])
        return ''.join(out)
    return apply
