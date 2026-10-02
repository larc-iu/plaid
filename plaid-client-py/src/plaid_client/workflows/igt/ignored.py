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

import unicodedata
from bisect import bisect_right

from .glossing import is_zero_morph

#: ``\p{Extended_Pictographic}`` as inclusive code-point ranges, since Python's
#: ``re`` has no such class: every code point node's ``/\p{Extended_Pictographic}/u``
#: matches (Unicode 16.0), run together.
_PICTOGRAPHIC = (
    (0x00A9, 0x00A9), (0x00AE, 0x00AE), (0x203C, 0x203C), (0x2049, 0x2049), (0x2122, 0x2122),
    (0x2139, 0x2139), (0x2194, 0x2199), (0x21A9, 0x21AA), (0x231A, 0x231B), (0x2328, 0x2328),
    (0x2388, 0x2388), (0x23CF, 0x23CF), (0x23E9, 0x23F3), (0x23F8, 0x23FA), (0x24C2, 0x24C2),
    (0x25AA, 0x25AB), (0x25B6, 0x25B6), (0x25C0, 0x25C0), (0x25FB, 0x25FE), (0x2600, 0x2605),
    (0x2607, 0x2612), (0x2614, 0x2685), (0x2690, 0x2705), (0x2708, 0x2712), (0x2714, 0x2714),
    (0x2716, 0x2716), (0x271D, 0x271D), (0x2721, 0x2721), (0x2728, 0x2728), (0x2733, 0x2734),
    (0x2744, 0x2744), (0x2747, 0x2747), (0x274C, 0x274C), (0x274E, 0x274E), (0x2753, 0x2755),
    (0x2757, 0x2757), (0x2763, 0x2767), (0x2795, 0x2797), (0x27A1, 0x27A1), (0x27B0, 0x27B0),
    (0x27BF, 0x27BF), (0x2934, 0x2935), (0x2B05, 0x2B07), (0x2B1B, 0x2B1C), (0x2B50, 0x2B50),
    (0x2B55, 0x2B55), (0x3030, 0x3030), (0x303D, 0x303D), (0x3297, 0x3297), (0x3299, 0x3299),
    (0x1F000, 0x1F0FF), (0x1F10D, 0x1F10F), (0x1F12F, 0x1F12F), (0x1F16C, 0x1F171),
    (0x1F17E, 0x1F17F), (0x1F18E, 0x1F18E), (0x1F191, 0x1F19A), (0x1F1AD, 0x1F1E5),
    (0x1F201, 0x1F20F), (0x1F21A, 0x1F21A), (0x1F22F, 0x1F22F), (0x1F232, 0x1F23A),
    (0x1F23C, 0x1F23F), (0x1F249, 0x1F3FA), (0x1F400, 0x1F53D), (0x1F546, 0x1F64F),
    (0x1F680, 0x1F6FF), (0x1F774, 0x1F77F), (0x1F7D5, 0x1F7FF), (0x1F80C, 0x1F80F),
    (0x1F848, 0x1F84F), (0x1F85A, 0x1F85F), (0x1F888, 0x1F88F), (0x1F8AE, 0x1F8FF),
    (0x1F90C, 0x1F93A), (0x1F93C, 0x1F945), (0x1F947, 0x1FAFF), (0x1FC00, 0x1FFFD),
)
_STARTS = [a for a, _ in _PICTOGRAPHIC]


def is_pictograph(c: str) -> bool:
    i = bisect_right(_STARTS, ord(c)) - 1
    return i >= 0 and ord(c) <= _PICTOGRAPHIC[i][1]


def is_punct_char(c: str) -> bool:
    """Punctuation for the ignore rule: P or S, not a pictograph, not the
    zero morph (igtConfig.js ``isPunctChar``)."""
    return unicodedata.category(c)[0] in 'PS' and not is_pictograph(c) and not is_zero_morph(c)


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
