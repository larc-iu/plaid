"""The words igt's "Tokenize new text" gives the text a write adds: plaid-igt's
``domain/newTextWords.js`` and the built-in tokenizer under it
(``utils/tokenizationUtils.js``), the one Python copy of each, so the igt
assistant's text edits and the ASR transcription get the words a Baseline save
would.

The project turns it off on the word layer (``config.igt.tokenizeNewText`` is
``false``), and it is on when the key is absent. The words are measured on the
body the edit makes, before the server has placed the existing words on it,
and kept off every position an existing word may end up over: its own text,
all the text a change types when the change reaches inside a word or takes one
whole, and text typed against a word's edge with no whitespace between. Each
gap is first trimmed of the text its value shares with what it replaces at
either end, as the server reads it (plaid-core's ``trim-gap``). What
is left, where the edit typed something, is cut by the built-in tokenizer
(``split_words``). A candidate made only of ignored characters gets no
word, and neither does one holding a letter of a script written without spaces
(Han, kana, Thai and the like, ``spaceless_scripts.py``, a table generated with
the app's).

``plaid-agent/tests/test_igt_tokens_mirror.py`` runs the app's modules over a
case table and compares.
"""

import re
from bisect import bisect_right
from typing import Any, List, Optional, Sequence, Tuple

from .ignored import is_token_ignored
from .spaceless_scripts import SPACELESS_SCRIPTS

# The editor's isUnicodePunctuation character class, verbatim (without
# U+111C9 and U+111DA, which the editor dropped as not punctuation).
# test_igt_tokens_mirror.py compares it with the editor's on every code point.
_EDITOR_PUNCT = re.compile('[' + '''\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u00A1-\u00A9\u00AB-\u00B1\u00B4\u00B6-\u00B8\u00BB\u00BF\u037E\u0387\u055A-\u055F\u0589-\u058A\u05BE\u05C0\u05C3\u05C6\u05F3-\u05F4\u0609-\u060A\u060C-\u060D\u061B\u061E-\u061F\u066A-\u066D\u06D4\u0700-\u070D\u07F7-\u07F9\u0830-\u083E\u085E\u0964-\u0965\u0970\u09FD\u0A76\u0AF0\u0C77\u0C84\u0DF4\u0E4F\u0E5A-\u0E5B\u0F04-\u0F12\u0F14\u0F3A-\u0F3D\u0F85\u0FD0-\u0FD4\u0FD9-\u0FDA\u104A-\u104F\u10FB\u1360-\u1368\u1400\u166E\u169B-\u169C\u16EB-\u16ED\u1735-\u1736\u17D4-\u17D6\u17D8-\u17DA\u1800-\u180A\u1944-\u1945\u1A1E-\u1A1F\u1AA0-\u1AA6\u1AA8-\u1AAD\u1B5A-\u1B60\u1BFC-\u1BFF\u1C3B-\u1C3F\u1C7E-\u1C7F\u1CC0-\u1CC7\u1CD3\u2010-\u2027\u2030-\u2043\u2045-\u2051\u2053-\u205E\u207D-\u207E\u208D-\u208E\u2308-\u230B\u2329-\u232A\u2768-\u2775\u27C5-\u27C6\u27E6-\u27EF\u2983-\u2998\u29D8-\u29DB\u29FC-\u29FD\u2CF9-\u2CFC\u2CFE-\u2CFF\u2D70\u2E00-\u2E2E\u2E30-\u2E4F\u2E52-\u2E5D\u3001-\u3003\u3008-\u3011\u3014-\u301F\u3030\u303D\u30A0\u30FB\uA4FE-\uA4FF\uA60D-\uA60F\uA673\uA67E\uA6F2-\uA6F7\uA874-\uA877\uA8CE-\uA8CF\uA8F8-\uA8FA\uA8FC\uA92E-\uA92F\uA95F\uA9C1-\uA9CD\uA9DE-\uA9DF\uAA5C-\uAA5F\uAADE-\uAADF\uAAF0-\uAAF1\uABEB\uFD3E-\uFD3F\uFE10-\uFE19\uFE30-\uFE52\uFE54-\uFE61\uFE63\uFE68\uFE6A-\uFE6B\uFF01-\uFF03\uFF05-\uFF0A\uFF0C-\uFF0F\uFF1A-\uFF1B\uFF1F-\uFF20\uFF3B-\uFF3D\uFF3F\uFF5B\uFF5D\uFF5F-\uFF65\U00010100-\U00010102\U0001039F\U000103D0\U0001056F\U00010857\U0001091F\U0001093F\U00010A50-\U00010A58\U00010A7F\U00010AF0-\U00010AF6\U00010B39-\U00010B3F\U00010B99-\U00010B9C\U00010F55-\U00010F59\U00011047-\U0001104D\U000110BB-\U000110BC\U000110BE-\U000110C1\U00011140-\U00011143\U00011174-\U00011175\U000111C5-\U000111C8\U000111DD\U000111DB\U00011238-\U0001123D\U000112A9\U0001144B-\U0001144F\U0001145A-\U0001145B\U0001145D\U000114C6\U000115C1-\U000115D7\U00011641-\U00011643\U00011660-\U0001166C\U0001173C-\U0001173E\U0001183B\U00011944-\U00011946\U000119E2\U00011A3F-\U00011A46\U00011A9A-\U00011A9C\U00011A9E-\U00011AA2\U00011C41-\U00011C45\U00011C70-\U00011C71\U00011EF7-\U00011EF8\U00012470-\U00012474\U00016A6E-\U00016A6F\U00016AF5\U00016B37-\U00016B3B\U00016B44\U00016E97-\U00016E9A\U0001BC9F\U0001DA87-\U0001DA8B\U0001E95E-\U0001E95F''' + ']')


def is_unicode_punctuation(c: str) -> bool:
    """The editor's rule for a punctuation character (tokenizationUtils.js)."""
    return len(c) == 1 and bool(_EDITOR_PUNCT.match(c))


def _is_break_char(c: str, cfg) -> bool:
    """Does this character end a word (the editor's shouldTokenizeCharacter,
    with its exact punctuation class)? Unless whitelisted; or, under a
    blacklist config, exactly the listed characters."""
    punct = is_unicode_punctuation(c)
    if not cfg:
        return punct
    if cfg.get('type') == 'unicodePunctuation':
        return punct and c not in (cfg.get('whitelist') or [])
    if cfg.get('type') == 'blacklist':
        return c in (cfg.get('blacklist') or [])
    return punct


# JavaScript's ``\s`` (and what its ``trim`` strips), which the editor's
# tokenizer reads. Python's ``str.isspace`` differs at the edges: it takes the
# information separators U+001C to U+001F and U+0085, and not U+FEFF.
_JS_SPACE = frozenset('\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006'
                      '\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')


def is_js_space(c: str) -> bool:
    """Whitespace as the editor's tokenizer reads it (JavaScript's)."""
    return c in _JS_SPACE


def _blank(text: str, b: int, e: int) -> bool:
    return all(c in _JS_SPACE for c in text[b:e])


def split_words(text: str, begin: int, end: int, cfg) -> List[tuple]:
    """(begin, end) word ranges inside one sentence: whitespace and break
    characters separate words; break characters are not tokens (they stay in
    the gap), as in the editor."""
    out = []
    i = begin
    cur = begin
    while i < end:
        c = text[i]
        if c in _JS_SPACE or _is_break_char(c, cfg):
            if i > cur and not _blank(text, cur, i):
                out.append(_trimmed(text, cur, i))
            i += 1
            while i < end and text[i] in _JS_SPACE:
                i += 1
            cur = i
        else:
            i += 1
    if cur < end and not _blank(text, cur, end):
        out.append(_trimmed(text, cur, end))
    return out


def _trimmed(text, b, e):
    while b < e and text[b] in _JS_SPACE:
        b += 1
    while e > b and text[e - 1] in _JS_SPACE:
        e -= 1
    return (b, e)


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


def _trim_gaps(old: str, gaps) -> List[Tuple[int, int, str]]:
    """``gaps`` over ``old``, each without the text its value shares with the
    old at either end, as the server reads it (plaid-core's ``trim-gap``),
    and none that is left with nothing."""
    out = []
    for start, end, value in gaps:
        n, k = len(value), end - start
        front = 0
        while front < n and front < k and value[front] == old[start + front]:
            front += 1
        back = 0
        while back < n - front and back < k - front and value[n - 1 - back] == old[end - 1 - back]:
            back += 1
        if front + back == n and front + back == k:
            continue
        out.append((start + front, end - back, value[front:n - back]))
    return out


def new_text_words(base: str, gaps: Sequence[Any], words: Sequence[Any], ignored: Optional[dict],
                   sentences: Sequence[Any] = ()) -> List[Tuple[int, int]]:
    """The words to create with an edit of ``gaps`` over ``base``.

    ``gaps`` are ``{start, end, value}`` (or ``(start, end, value)``) in code
    points of ``base``, in order and not overlapping. ``words`` are the word
    tokens on ``base`` (``{begin, end}`` or ``(begin, end)``). ``ignored`` is
    the ignored-tokens rule. ``sentences`` are the sentences on ``base``: no
    new word crosses one of their boundaries. Returns ``(begin, end)`` ranges
    in code points of the body the edit makes, in order."""
    old = base or ''
    srt = sorted(_trim_gaps(old, [_gap(g) for g in gaps or []]), key=lambda g: g[0])
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

    # The sentence boundaries, moved by the edit, cut every candidate: a word
    # is never made across one (the word layer lies inside the sentences).
    # Text typed at a boundary goes to the sentence before, as the server puts
    # it. Where a gap that deletes reaches a boundary, which sentence its
    # typed text lands in is the server's to say, so that text gets no word.
    cut = bytearray(n + 1)
    for snt in sentences or ():
        p = snt['begin'] if isinstance(snt, dict) else snt[0]
        if not 0 < p < len(old):
            continue
        i = last_starting(p, False)
        touching = [j for j in range(max(0, i - 1), i + 1) if j >= 0 and srt[j][0] <= p <= srt[j][1]]
        if not touching:
            cut[start_of(p)] = 1
        elif all(srt[j][0] == p and srt[j][1] == p for j in touching):
            cut[at[touching[-1]] + lens[touching[-1]]] = 1
        else:
            for j in touching:
                cut[at[j]] = 1
                cut[at[j] + lens[j]] = 1
                for x in range(at[j], at[j] + lens[j]):
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
        while y < n and not covered[y] and not (y > x and cut[y]):
            y += 1
        for b, e in split_words(text, x, y, ignored):
            if not any(typed[b:e]):
                continue
            if is_token_ignored(text[b:e], ignored) or is_spaceless(text[b:e]):
                continue
            out.append((b, e))
        x = y
    return out


def layer_new_words(word_layer_config, base: str, gaps: Sequence[Any], words: Sequence[Any],
                    sentences: Sequence[Any] = ()) -> List[Tuple[int, int]]:
    """``new_text_words`` under the word layer's config: its "Tokenize new
    text" (none when it is off) and its ignored-tokens rule, kept inside
    ``sentences``."""
    if not tokenize_new_text(word_layer_config):
        return []
    igt = (word_layer_config or {}).get('igt') if isinstance(word_layer_config, dict) else None
    ignored = igt.get('ignoredTokens') if isinstance(igt, dict) else None
    return new_text_words(base, gaps, words, ignored, sentences)


def words_refused(e) -> bool:
    """Whether a write was refused for its new words alone: one lies over a
    word the server placed, or outside every sentence (a boundary the
    prediction did not foresee). Nothing of that write is stored, and it can
    go again without them."""
    data = getattr(e, 'response_data', None)
    text = str((data.get('error') if isinstance(data, dict) else None) or e)
    return getattr(e, 'status', None) in (400, 409) and any(
        m in text for m in ('Bulk-created token overlaps', 'Tokens in batch overlap',
                            'not contained within any parent-layer token'))
