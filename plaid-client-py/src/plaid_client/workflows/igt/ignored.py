"""Which word tokens IGT leaves out of annotation: plaid-igt's ignored-tokens
rule (``domain/igtConfig.js``, ``isTokenIgnored``), the one Python copy of it.
Every Python reader of IGT words numbers them past the tokens this ignores, so
a word reference agrees with the editor's only while this agrees with the app.
``plaid-agent/tests/test_igt_tokens_mirror.py`` runs the app's rule over a
case table and compares.

The word layer's ``config.igt.ignoredTokens`` is one of two rules:

* ``unicodePunctuation``: a token made only of punctuation is ignored.
  Punctuation is Unicode P or S, except pictographs (an emoji may be a word a
  linguist glosses) and the zero morph, and except the characters the project
  lists as letter-like (``whitelist``, single characters, each one a letter
  wherever it stands).
* ``blacklist``: a token spelled exactly as one listed is ignored.
"""

from bisect import bisect_right

from .glossing import is_zero_morph
from .punctuation_classes import PICTOGRAPHIC, PUNCT_OR_SYMBOL

# The character classes are one generated table, the app's too
# (plaid-igt/tools/punctuationClasses.mjs writes both), pinned to one Unicode
# version. Python's ``re`` has no ``\p{Extended_Pictographic}`` and its
# ``unicodedata`` is an older Unicode, and a browser's ``\p{}`` is whatever its
# engine ships, so asking either would let a word reference mean different
# words in different places.


def _in(ranges, starts, c: str) -> bool:
    i = bisect_right(starts, ord(c)) - 1
    return i >= 0 and ord(c) <= ranges[i][1]


_PS_STARTS = [a for a, _ in PUNCT_OR_SYMBOL]
_PICTO_STARTS = [a for a, _ in PICTOGRAPHIC]


def is_pictograph(c: str) -> bool:
    return _in(PICTOGRAPHIC, _PICTO_STARTS, c)


def is_punct_char(c: str) -> bool:
    """Punctuation for the ignore rule: P or S, not a pictograph, not the
    zero morph (igtConfig.js ``isPunctChar``)."""
    return _in(PUNCT_OR_SYMBOL, _PS_STARTS, c) and not is_pictograph(c) and not is_zero_morph(c)


def is_letter_like(c: str, cfg) -> bool:
    """Has the project declared this character a letter? (``isLetterLike``)."""
    return bool(cfg) and cfg.get('type') == 'unicodePunctuation' and c in (cfg.get('whitelist') or [])


def is_ignorable_char(c: str, cfg) -> bool:
    """Punctuation the project has not declared letter-like (``isIgnorableChar``)."""
    return is_punct_char(c) and not is_letter_like(c, cfg)


def is_token_ignored(content, cfg) -> bool:
    """Is this word token left out of annotation by the word layer's
    ``config.igt.ignoredTokens`` rule? (``isTokenIgnored``)."""
    if not cfg:
        return False
    if cfg.get('type') == 'unicodePunctuation':
        return all(is_ignorable_char(c, cfg) for c in (content or ''))
    if cfg.get('type') == 'blacklist':
        return content in (cfg.get('blacklist') or [])
    return False
