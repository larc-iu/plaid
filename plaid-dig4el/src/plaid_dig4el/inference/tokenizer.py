"""dig4el's delimiter tokenizer, kept for reading legacy knowledge graphs and for the
parity test. Documents living in Plaid carry real word tokens and never need it.

Ported from ``libs/stats.py`` (Sebastien Christian, AGPL-3.0)."""

from __future__ import annotations

import re
from collections import defaultdict

DEFAULT_DELIMITERS = [".", ",", ":", ";", "?", "!", "(", ")", " "]
_PUNCTUATION = [".", ",", ":", ";", "?", "!", "(", ")"]


def custom_split(text: str, delimiters=DEFAULT_DELIMITERS) -> list[str]:
    """Split on the delimiters, strip punctuation, lowercase, and suffix repeated words
    with ``_2``, ``_3``... so a repeated form can be told apart within one sentence."""
    pattern = "|".join(map(re.escape, delimiters))
    split_text = re.split(pattern, text)
    split_text = [word.strip("".join(_PUNCTUATION)) for word in split_text]
    split_text = [word for word in split_text if word]
    split_text = [word.strip() for word in split_text]
    split_text = [word.lower() for word in split_text]
    word_counts: dict[str, int] = defaultdict(int)
    unique_words = []
    for word in split_text:
        word_counts[word] += 1
        if word_counts[word] > 1:
            unique_words.append(f"{word}_{word_counts[word]}")
        else:
            unique_words.append(word)
    return unique_words
