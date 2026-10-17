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
whole, and text typed against a word's edge with no whitespace between (none
for a word made only of punctuation). Each
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

from bisect import bisect_right
from typing import Any, List, Optional, Sequence, Tuple

from .ignored import is_text_punctuation, is_token_ignored
from .punctuation_classes import WORD_BREAK
from .spaceless_scripts import SPACELESS_SCRIPTS

_BREAK_STARTS = [a for a, _ in WORD_BREAK]


def is_unicode_punctuation(c: str) -> bool:
    """The editor's rule for a punctuation character (tokenizationUtils.js),
    from the generated break class."""
    if len(c) != 1:
        return False
    i = bisect_right(_BREAK_STARTS, ord(c)) - 1
    return i >= 0 and ord(c) <= WORD_BREAK[i][1]


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


# JavaScript's ``\s`` (what its ``trim`` strips) and NEL (U+0085), which the
# editor's tokenizer reads as whitespace (plaid-ui ``isWordSpace``, plaid-core
# ``space?``). Python's ``str.isspace`` differs at the edges: it takes the
# information separators U+001C to U+001F, and not U+FEFF.
_JS_SPACE = frozenset('\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006'
                      '\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')


def _is_line_break(c: str) -> bool:
    return c in "\n\r\u0085\u2028\u2029"


def is_js_space(c: str) -> bool:
    """Whitespace as the editor's tokenizer reads it (JavaScript's ``\\s``
    and NEL)."""
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


def new_text_layout(base: str, gaps: Sequence[Any], words: Sequence[Any], sentences: Sequence[Any] = (),
                    ignored: Optional[dict] = None):
    """Where an edit of ``gaps`` over ``base`` may make words, as
    ``new_text_words`` takes them: ``(body, typed, covered, cut)``, the body
    the edit makes (a list of code points), which of them the edit typed,
    which an existing word may end up over, and where core puts a sentence
    boundary (``cut``, 1 at each such position, held to core's by
    ``tests/test_sentence_cut_cases.py`` on plaid-core's shared case table).
    ``ignored`` is the ignored-tokens rule, whose letter-like characters are
    no punctuation to core. None when the edit types nothing."""
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
        return None

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
    # What typed text against it with no whitespace between goes to: all that
    # is covered but the text of a word made only of punctuation, which takes
    # none (plaid-core ``apply-plain-gaps``, ``punct?``: what igt's
    # punctuation rule skips, a character the project's rule calls
    # letter-like being a letter, whichever rule is in force).
    takes = bytearray(n)
    for w in words or []:
        wb, we = (w['begin'], w['end']) if isinstance(w, dict) else (w[0], w[1])
        if not wb < we:
            continue
        lo, hi = start_of(wb), end_of(we)
        punct = all(is_text_punctuation(c, ignored) for c in old[wb:we])
        for x in range(max(0, lo), min(n, hi)):
            covered[x] = 1
            # (text a gap typed inside it, which the server may give it, does)
            if not punct or typed[x]:
                takes[x] = 1

    # The sentence boundaries, moved by the edit, cut every candidate: a word
    # is never made across one (the word layer lies inside the sentences).
    # Text typed between two sentences goes where the server puts it: to the
    # one after when typed past whitespace on that sentence's first line, or
    # right after the punctuation the one before ends on, else to the one
    # before (plaid-core `apply-plain-gaps`). Where a gap that deletes reaches
    # a boundary, which sentence its typed text lands in is the server's to
    # say, so that text gets no word. Past whitespace, the text goes to the
    # first sentence beginning at or after it, and so does the text of every
    # other insert in the same whitespace before it (`run-start`, `run-at`).
    begins = [snt['begin'] if isinstance(snt, dict) else snt[0] for snt in sentences or ()]

    def no_begin(a: int, x: int) -> bool:
        return not any(a <= b < x for b in begins)

    def next_letter(j: int) -> Optional[int]:
        # The next letter's position for an insert after whitespace with no
        # line break in it or between it and that letter, else None.
        a, b, value = srt[j]
        if a != b or not 0 < a < len(old) or not is_js_space(old[a - 1]):
            return None
        if any(_is_line_break(c) for c in value):
            return None
        for x in range(a, len(old)):
            if not is_js_space(old[x]):
                return x
            if _is_line_break(old[x]):
                return None
        return None

    letters = [next_letter(j) for j in range(len(srt))]
    run_start: List[int] = []
    for j in range(len(srt)):
        run_start.append(run_start[j - 1] if j > 0 and letters[j] is not None and letters[j - 1] == letters[j] else j)

    def to_next(j: int, p: int) -> bool:
        a, b, value = srt[j]
        if a != b or a > p or not 0 < a < len(old):
            return False
        if any(_is_line_break(c) for c in value):
            return False
        if not is_js_space(old[a - 1]):
            return a == p and not is_js_space(old[a]) and is_text_punctuation(old[a - 1], ignored)
        return letters[j] is not None and p <= letters[j] and no_begin(a, p)

    def run_at(j: int, p: int) -> int:
        # Where the sentence beginning at ``p`` begins when ``to_next(j, p)``.
        h = j
        while h > run_start[j] and no_begin(srt[h - 1][0], p):
            h -= 1
        return at[h]

    cut = bytearray(n + 1)
    for snt in sentences or ():
        p = snt['begin'] if isinstance(snt, dict) else snt[0]
        if not 0 < p < len(old):
            continue
        i = last_starting(p, False)
        touching = [j for j in range(max(0, i - 1), i + 1) if j >= 0 and srt[j][0] <= p <= srt[j][1]]
        if not touching:
            cut[run_at(i, p) if i >= 0 and to_next(i, p) else start_of(p)] = 1
        elif all(srt[j][0] == p and srt[j][1] == p for j in touching):
            j = touching[-1]
            cut[run_at(j, p) if to_next(j, p) else at[j] + lens[j]] = 1
        else:
            for j in touching:
                cut[at[j]] = 1
                cut[at[j] + lens[j]] = 1
                for x in range(at[j], at[j] + lens[j]):
                    covered[x] = takes[x] = 1

    # A line typed before the first sentence's first letter left, holding a
    # letter before its last line break, is a sentence of its own: the first
    # sentence begins at the first letter after that line (plaid-core
    # `apply-plain-gaps`, `head-end`). "A letter" is anything but whitespace
    # or NEL, so a line of only no-break or ideographic spaces (an indent) or
    # of NEL is not one.
    # Not where a word the save typed over with the line
    # ends inside it, which core keeps on its own text.
    first = next((snt for snt in sentences or () if (snt['begin'] if isinstance(snt, dict) else snt[0]) == 0), None)
    if first is not None:
        first_end = first['end'] if isinstance(first, dict) else first[1]
        q = next((x for x in range(min(first_end, len(old)))
                  if not is_js_space(old[x]) and not any(s <= x < e for s, e, _ in srt)), -1)
        if q >= 0:
            p = start_of(q)
            k = next((x + 1 for x in range(p - 1, -1, -1) if _is_line_break(body[x])), -1)
            letter = k > 0 and any(not is_js_space(c) for c in body[:k])
            spans = [(w['begin'], w['end']) if isinstance(w, dict) else (w[0], w[1]) for w in words or []]
            typed_over = any(wb < we and any(s <= wb and we <= e and v for s, e, v in srt) and end_of(we) <= k
                             for wb, we in spans)
            if letter and not typed_over:
                e = end_of(first_end)
                b = k
                while b < e and is_js_space(body[b]):
                    b += 1
                cut[min(b, e - 1)] = 1

    # Typed text against a word with no whitespace between goes to the word,
    # unless the word is made only of punctuation.
    def joins(x: int) -> bool:
        return typed[x] and not is_js_space(body[x])

    for x in range(1, n):
        if not covered[x] and takes[x - 1] and joins(x):
            covered[x] = takes[x] = 1
    for x in range(n - 2, -1, -1):
        if not covered[x] and takes[x + 1] and joins(x):
            covered[x] = takes[x] = 1
    return body, typed, covered, cut


def new_text_words(base: str, gaps: Sequence[Any], words: Sequence[Any], ignored: Optional[dict],
                   sentences: Sequence[Any] = ()) -> List[Tuple[int, int]]:
    """The words to create with an edit of ``gaps`` over ``base``.

    ``gaps`` are ``{start, end, value}`` (or ``(start, end, value)``) in code
    points of ``base``, in order and not overlapping. ``words`` are the word
    tokens on ``base`` (``{begin, end}`` or ``(begin, end)``). ``ignored`` is
    the ignored-tokens rule. ``sentences`` are the sentences on ``base``: no
    new word crosses one of their boundaries. Returns ``(begin, end)`` ranges
    in code points of the body the edit makes, in order."""
    layout = new_text_layout(base, gaps, words, sentences, ignored)
    if layout is None:
        return []
    body, typed, covered, cut = layout
    n = len(body)
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
