"""The words igt's "Tokenize new text" gives the text a write adds: plaid-igt's
``domain/newTextWords.js``, the one Python copy of it, so the assistant's text
edits get the words a Baseline save would.

The project turns it off on the word layer (``config.igt.tokenizeNewText`` is
``false``), and it is on when the key is absent. The words are measured on the
body the edit makes, before the server has placed the existing words on it,
and kept off every position an existing word may end up over: its own text,
all the text a change types when the change reaches inside a word or takes one
whole, and text typed against a word's edge with no whitespace between. What
is left, where the edit typed something, is cut by the built-in tokenizer
(``project.split_words``). A candidate made only of ignored characters gets no
word, and neither does one holding a letter of a script written without spaces
(Han, kana, Thai and the like, ``spaceless_scripts.py``, a table generated with
the app's).

``plaid-agent/tests/test_igt_tokens_mirror.py`` runs the app's module over a
case table and compares.
"""

from bisect import bisect_right
from typing import Any, List, Optional, Sequence, Tuple

from plaid_client.workflows.igt import is_token_ignored

from .project import is_js_space, split_words
from .spaceless_scripts import SPACELESS_SCRIPTS

_STARTS = [a for a, _ in SPACELESS_SCRIPTS]


def is_spaceless_script(c: str) -> bool:
    """Is the first code point of ``c`` in a script written without spaces?"""
    if not c:
        return False
    i = bisect_right(_STARTS, ord(c[0])) - 1
    return i >= 0 and ord(c[0]) <= SPACELESS_SCRIPTS[i][1]


def is_spaceless(text: str) -> bool:
    """Whether a stretch holds a letter of a script written without spaces."""
    return any(is_spaceless_script(c) for c in (text or ''))


def tokenize_new_text(word_layer_config) -> bool:
    """The word layer's "Tokenize new text": on unless set to ``false``."""
    igt = (word_layer_config or {}).get('igt') if isinstance(word_layer_config, dict) else None
    return not (isinstance(igt, dict) and igt.get('tokenizeNewText') is False)


def _gap(g) -> Tuple[int, int, str]:
    if isinstance(g, dict):
        return g['start'], g['end'], g.get('value') or ''
    return g[0], g[1], g[2] or ''


def new_text_words(base: str, gaps: Sequence[Any], words: Sequence[Any], ignored: Optional[dict]) -> List[Tuple[int, int]]:
    """The words to create with an edit of ``gaps`` over ``base``.

    ``gaps`` are ``{start, end, value}`` (or ``(start, end, value)``) in code
    points of ``base``, in order and not overlapping. ``words`` are the word
    tokens on ``base`` (``{begin, end}`` or ``(begin, end)``). ``ignored`` is
    the ignored-tokens rule. Returns ``(begin, end)`` ranges in code points of
    the body the edit makes, in order."""
    old = base or ''
    srt = sorted((_gap(g) for g in gaps or []), key=lambda g: g[0])
    body: List[str] = []
    typed: List[bool] = []
    at: List[int] = []
    lens: List[int] = []
    pos = 0
    for start, end, value in srt:
        for i in range(pos, start):
            body.append(old[i])
            typed.append(False)
        at.append(len(body))
        lens.append(len(value))
        for c in value:
            body.append(c)
            typed.append(True)
        pos = end
    for i in range(pos, len(old)):
        body.append(old[i])
        typed.append(False)
    n = len(body)
    if not any(typed):
        return []

    def last_starting(p: int, strict: bool) -> int:
        lo, hi = 0, len(srt)
        while lo < hi:
            m = (lo + hi) >> 1
            if (srt[m][0] < p) if strict else (srt[m][0] <= p):
                lo = m + 1
            else:
                hi = m
        return lo - 1

    def after(i: int, p: int) -> int:
        return p - srt[i][1] + at[i] + lens[i]

    def start_of(p: int) -> int:
        # After text inserted right at it, at the start of the text that replaced it.
        i = last_starting(p, False)
        if i < 0:
            return p
        start, end, _ = srt[i]
        if start == p and end == p:
            return at[i] + lens[i]
        if start <= p < end:
            return at[i]
        return after(i, p)

    def end_of(p: int) -> int:
        # Before text inserted right at it, at the end of the text that replaced it.
        j = last_starting(p, False)
        if j >= 0 and srt[j][0] == p and srt[j][1] == p:
            return at[j]
        i = last_starting(p, True)
        if i < 0:
            return p
        if p <= srt[i][1]:
            return at[i] + lens[i]
        return after(i, p)

    covered = bytearray(n)
    for w in words or []:
        wb, we = (w['begin'], w['end']) if isinstance(w, dict) else (w[0], w[1])
        if not wb < we:
            continue
        lo, hi = start_of(wb), end_of(we)
        for x in range(max(0, lo), min(n, hi)):
            covered[x] = 1

    # Typed text against a word with no whitespace between goes to the word.
    def joins(x: int) -> bool:
        return typed[x] and not is_js_space(body[x])

    for x in range(1, n):
        if not covered[x] and covered[x - 1] and joins(x):
            covered[x] = 1
    for x in range(n - 2, -1, -1):
        if not covered[x] and covered[x + 1] and joins(x):
            covered[x] = 1

    text = ''.join(body)
    out: List[Tuple[int, int]] = []
    x = 0
    while x < n:
        if covered[x]:
            x += 1
            continue
        y = x
        while y < n and not covered[y]:
            y += 1
        for b, e in split_words(text, x, y, ignored):
            if not any(typed[b:e]):
                continue
            if is_token_ignored(text[b:e], ignored) or is_spaceless(text[b:e]):
                continue
            out.append((b, e))
        x = y
    return out


def project_new_words(project, base: str, gaps: Sequence[Any], words: Sequence[Any]) -> List[Tuple[int, int]]:
    """``new_text_words`` under the project's setting: none when it is off."""
    if not getattr(project, 'tokenize_new_text', True):
        return []
    return new_text_words(base, gaps, words, project.ignored_cfg)

