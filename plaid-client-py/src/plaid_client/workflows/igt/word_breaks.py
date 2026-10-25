"""Where igt's built-in tokenizer (plaid-igt ``utils/tokenizationUtils.js``,
plaid-ui ``igtWordBreaks.js``) breaks a word, the one Python copy, which the
igt assistant and the ASR transcription read. The words a write's new text
gets ("Tokenize new text") are the server's: a text write names the word layer
(``tokenize_layer``).

``plaid-agent/tests/test_igt_tokens_mirror.py`` runs the app's tokenizer over a
case table and compares.
"""

from bisect import bisect_right
from typing import List

from .punctuation_classes import WORD_BREAK

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
