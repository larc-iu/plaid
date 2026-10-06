"""Reading back a positional reference a model wrote.

The tools print ``s3.w2`` (and an app's deeper parts after it). What a model
types back is that or close to it: ``S3.W2``, ``s3:w2``, ``s3.2`` (the number a
row carries, as CoNLL-U's ID column shows it), ``s3.w2 "casa"`` with the form
it read beside the number, or ``s3."casa"`` naming a word by its form, with
``#2`` for the second one spelled that way. Each of those says one thing, so
each is read.

What says two things is never resolved here: a form that is not the one at
that number, or a form the sentence holds twice with no number to choose. The
app refuses those, naming what is there. Writes go through the same reader, so
a reading that guessed would put a value on a word nobody named.
"""

import re
import unicodedata
from dataclasses import dataclass
from typing import Optional, Sequence

# A form after the number, set off the way a model quotes one: in quotes, in
# brackets, after "=" or ":", or after a space.
_TAIL_RE = re.compile(r'''^\s*(?:"([^"]*)"|“([^”]*)”|'([^']*)'|‘([^’]*)’|«([^»]*)»|\(([^)]*)\)'''
                      r'''|[=:]\s*(\S.*?)|\s(\S.*?))\s*$''', re.S)
# A word named by its form: "s3.casa", "s3:'casa'", "s3.casa#2".
_BY_FORM_RE = re.compile(r'^\s*[.:/]\s*(?P<form>.+?)(?:\s*#\s*(?P<nth>\d+))?\s*$', re.S)
# Another reference inside what would be read as a form: two references
# in one string are a list written wrong ("s3.w2 (casa), s3.w4"), not a
# form to check.
_ANOTHER = re.compile(r'(?<![^\W_])s\s*\d', re.I)
_QUOTED = re.compile(r'''^(?:"(.*)"|“(.*)”|'(.*)'|‘(.*)’|«(.*)»|\((.*)\))$''', re.S)


@dataclass
class Ref:
    """One reference as read: the sentence, then each deeper part's number
    (None where it stops), the end of a range, and a form where one was given
    (beside the number, as a check, or in place of it, as the address)."""
    sentence: int
    parts: tuple
    until: Optional[int] = None
    form: Optional[str] = None
    nth: Optional[int] = None
    by_form: bool = False


def _pattern(letters: Sequence[str], ranged: bool) -> re.Pattern:
    rx = r'^\s*s\s*(\d+)'
    for i, letter in enumerate(letters):
        part = rf'\s*(?:[.:/]\s*{letter}?|{letter})\s*(\d+)'
        if ranged and i == len(letters) - 1:
            part += rf'(?:\s*-\s*{letter}?\s*(\d+))?'
        rx += '(?:' + part
    rx += ')?' * len(letters)
    return re.compile(rx + r'(?P<tail>.*)$', re.I | re.S)


_PATTERNS = {}


def read_ref(ref, letters: Sequence[str], ranged: bool = False) -> Optional[Ref]:
    """``ref`` as a :class:`Ref`, or None when it is not a reference at all.
    ``letters`` are the parts below a sentence ("w", then "m" in an app that
    has them), and ``ranged`` lets the last part be a range ("w1-2")."""
    key = (tuple(letters), ranged)
    if key not in _PATTERNS:
        _PATTERNS[key] = _pattern(letters, ranged)
    m = _PATTERNS[key].match(str(ref if ref is not None else ''))
    if not m:
        return None
    groups = m.groups()[:-1]
    sentence = int(groups[0])
    nums = list(groups[1:])
    until = None
    if ranged and letters:
        until = nums.pop()
        until = int(until) if until else None
    parts = tuple(int(n) if n else None for n in nums)
    tail = m.group('tail')
    if not tail.strip():
        return Ref(sentence, parts, until)
    if parts[0] is None:
        by = _BY_FORM_RE.match(tail)
        if not by:
            return None
        form = unquote(by.group('form'))
        if not form or _ANOTHER.search(form):
            return None
        return Ref(sentence, parts, None, form, int(by.group('nth')) if by.group('nth') else None, True)
    t = _TAIL_RE.match(tail)
    if not t:
        return None
    form = next((g for g in t.groups() if g is not None), '').strip()
    if not form or _ANOTHER.search(form):
        return None
    return Ref(sentence, parts, until, form)


def unquote(text: str) -> str:
    text = (text or '').strip()
    m = _QUOTED.match(text)
    if m:
        text = next(g for g in m.groups() if g is not None).strip()
    return text


def same_form(a: Optional[str], b: Optional[str], edges: str = '') -> bool:
    """Whether a form a model wrote is the one stored: compared as the reader
    sees them, so case and Unicode composition do not count, and neither do
    the ``edges`` characters at either end (an affix marker the app writes)."""
    def norm(s):
        return unicodedata.normalize('NFC', (s or '').strip().strip(edges)).casefold()
    return bool(norm(a)) and norm(a) == norm(b)


def clip(form: str, n: int = 24) -> str:
    """A form as a refusal quotes it: a whole untokenized line would bury the
    sentence it is quoted in."""
    form = form or ''
    return form if len(form) <= n else form[:n - 1] + '…'
