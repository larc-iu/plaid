"""The interleaved interlinear exchange format and its alignment back onto
the input words.

A proposer emits one line per sentence of whitespace-separated words, each
word ``GLOSS(seg)-GLOSS(seg)…`` with ``-`` or ``=`` boundaries (PolyGloss's
native output; anything else can be asked to produce it). Models drop,
merge and invent words, so the output is aligned to the input words by
surface similarity rather than trusted positionally, and a word whose
morphemes could not be parsed degrades to one morpheme carrying the joined
gloss rather than being lost.
"""

import difflib
import re
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

BOUNDARY_RE = re.compile(r'[-=]')
MORPH_RE = re.compile(r'^(.*)\((.*)\)$')
ALIGN_THRESHOLD = 0.5  # min surface similarity for an output word to count


# --- clitic side of a "=" boundary (mirrors affixMarkers.cliticSideOfBoundary) ---

def clitic_side_of_boundary(left_idx, count):
    """'left' | 'right' | None: which side of the "=" after morpheme `left_idx`
    (0-based, in a word of `count` morphemes) is the clitic. By position only,
    as the grid types it (R47): the first piece a proclitic, the last an
    enclitic, a two-piece word's last an enclitic, an interior boundary
    neither."""
    if left_idx + 1 == count - 1:
        return 'right'
    return 'left' if left_idx == 0 else None


CLITIC_TYPE_BY_SIDE = {'left': 'proclitic', 'right': 'enclitic'}

#: The morpheme metadata key that records a type "=" set, holding that type
#: (plaid-igt's EQUALS_TYPE_KEY). The grid moves or clears a type only while
#: this names it.
EQUALS_TYPE_KEY = 'morphTypeFromEquals'

#: The key (True) on the morpheme after a typed "=" (plaid-igt's
#: EQUALS_BEFORE_KEY): the grid reads the word's "=" boundaries off it.
EQUALS_BEFORE_KEY = 'equalsBefore'


def equals_of_clitic(befores, k):
    """The pieces whose "=" key types piece ``k`` (plaid-igt's
    equalsOfClitic): ``befores`` says, per piece of a word, whether a "=" was
    typed before it. Clearing a clitic's type takes these keys away."""
    n = len(befores)
    out = []
    for j in range(1, n):
        if not befores[j]:
            continue
        side = clitic_side_of_boundary(j - 1, n)
        if (side == 'left' and j - 1 == k) or (side == 'right' and j == k):
            out.append(j)
    return out


def clitic_types(joiners, glosses):
    """morphType per piece of a chain (None = untyped) from its '=' boundaries.
    ``glosses`` gives the piece count. The rule reads none of them."""
    n = len(glosses)
    types: List[Optional[str]] = [None] * n
    for i, j in enumerate(joiners):
        if j != '=':
            continue
        side = clitic_side_of_boundary(i, n)
        if side is None:
            continue
        types[i if side == 'left' else i + 1] = CLITIC_TYPE_BY_SIDE[side]
    return types


# --- output parsing + alignment ----------------------------------------------

class ParsedWord:
    """One whitespace-delimited word of the proposer's output."""

    def __init__(self, raw: str):
        self.raw = raw
        parts = BOUNDARY_RE.split(raw)
        self.joiners = BOUNDARY_RE.findall(raw)
        self.glosses: List[str] = []
        self.segments: List[str] = []
        self.malformed = False
        for p in parts:
            m = MORPH_RE.match(p)
            if m:
                self.glosses.append(m.group(1))
                self.segments.append(m.group(2))
            else:
                self.glosses.append(p)
                self.segments.append('')
                self.malformed = True
        if not any(self.segments):
            self.malformed = True

    @property
    def surface(self):
        return ''.join(self.segments)

    def merged_with(self, other: 'ParsedWord') -> 'ParsedWord':
        """The model split one input word in two: rejoin with a '-' boundary."""
        return ParsedWord(self.raw + '-' + other.raw)


def parse_interleaved(text: str) -> List[ParsedWord]:
    """One output line -> its words."""
    return [ParsedWord(w) for w in (text or '').split()]


def _norm(s):
    return ''.join(c for c in (s or '').casefold() if unicodedata.category(c)[0] not in 'PSZ')


def similarity(a, b):
    a, b = _norm(a), _norm(b)
    if not a and not b:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def align_words(surfaces: List[str], outputs: List[ParsedWord]) -> List[Optional[ParsedWord]]:
    """Map each input word to an output word (or None). Fast path: same count
    and every pair similar. Otherwise a monotonic alignment (dynamic
    programming over word pairs, cost = 1 - surface similarity) that allows
    dropping an input word, dropping an output word, and merging two output
    words into one input word. Pairs below ALIGN_THRESHOLD are left unaligned."""
    n, m = len(surfaces), len(outputs)
    if n == m and all(similarity(s, o.surface) >= ALIGN_THRESHOLD for s, o in zip(surfaces, outputs)):
        return list(outputs)
    GAP_IN = 0.6  # an input word the model dropped
    GAP_OUT = 0.5  # an output word with no input (hallucinated, or punctuation)
    MERGE_PENALTY = 0.1
    MERGE_MARGIN = 0.15  # merging must beat the better single match by this much
    INF = float('inf')
    cost = [[INF] * (m + 1) for _ in range(n + 1)]
    back: List[List[Optional[Tuple[int, int, str]]]] = [[None] * (m + 1) for _ in range(n + 1)]
    cost[0][0] = 0.0
    for i in range(n + 1):
        for j in range(m + 1):
            c = cost[i][j]
            if c == INF:
                continue
            if i < n and j < m:
                v = c + (1 - similarity(surfaces[i], outputs[j].surface))
                if v < cost[i + 1][j + 1]:
                    cost[i + 1][j + 1] = v
                    back[i + 1][j + 1] = (i, j, 'match')
            if i < n and j + 1 < m:
                merged = outputs[j].surface + outputs[j + 1].surface
                sm = similarity(surfaces[i], merged)
                single = max(similarity(surfaces[i], outputs[j].surface),
                             similarity(surfaces[i], outputs[j + 1].surface))
                if sm > single + MERGE_MARGIN:
                    v = c + (1 - sm) + MERGE_PENALTY
                    if v < cost[i + 1][j + 2]:
                        cost[i + 1][j + 2] = v
                        back[i + 1][j + 2] = (i, j, 'merge')
            if i < n and c + GAP_IN < cost[i + 1][j]:
                cost[i + 1][j] = c + GAP_IN
                back[i + 1][j] = (i, j, 'skip_in')
            if j < m and c + GAP_OUT < cost[i][j + 1]:
                cost[i][j + 1] = c + GAP_OUT
                back[i][j + 1] = (i, j, 'skip_out')
    result: List[Optional[ParsedWord]] = [None] * n
    i, j = n, m
    while (i, j) != (0, 0):
        pi, pj, kind = back[i][j]
        if kind == 'match':
            o = outputs[pj]
            result[pi] = o if similarity(surfaces[pi], o.surface) >= ALIGN_THRESHOLD else None
        elif kind == 'merge':
            o = outputs[pj].merged_with(outputs[pj + 1])
            result[pi] = o if similarity(surfaces[pi], o.surface) >= ALIGN_THRESHOLD else None
        i, j = pi, pj
    return result


def analysis_for(surface: str, out: ParsedWord) -> Dict[str, Any]:
    """The analysis to write for one word. A malformed word degrades to a
    single morpheme carrying the joined gloss, so the model's gloss is still
    reviewable and a person can split by hand."""
    if out.malformed or len(out.glosses) != len(out.segments):
        gloss = ''.join(g + (out.joiners[k] if k < len(out.joiners) else '') for k, g in enumerate(out.glosses))
        return {'segments': [surface], 'glosses': [gloss], 'types': [None], 'joiners': [],
                'degraded': True, 'surface_mismatch': False}
    return {
        'segments': list(out.segments),
        'glosses': list(out.glosses),
        'types': clitic_types(out.joiners, out.glosses),
        'types_from_equals': True,
        'joiners': list(out.joiners),
        'degraded': False,
        'surface_mismatch': _norm(out.surface) != _norm(surface),
    }
