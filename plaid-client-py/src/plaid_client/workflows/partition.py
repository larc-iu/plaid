"""A complete partition of a text from ranges that may not be one.

A sentence layer is partitioning: the server takes it only as ranges that
tile the text, with no gap, no overlap and nothing empty, and refuses any
other inside the write. The tokenizer and the ASR alignment both make their
sentences through :func:`partition`.
"""

from typing import Dict, Iterable, List


def partition(ranges: Iterable[Dict], length: int) -> List[Dict]:
    """``ranges`` (``{'begin', 'end'}``, any order) made into ranges that
    tile ``[0, length)``: each clamped to the text, empty ones dropped, an
    overlap cut at the end of the range before, a gap given to the range
    before it, and the first one reaching back to 0. No ranges give one over
    the whole text, and no text gives none."""
    if length <= 0:
        return []
    out: List[Dict] = []
    cursor = 0
    for r in sorted(ranges, key=lambda x: (x['begin'], x['end'])):
        b = max(min(r['begin'], length), cursor)
        e = max(0, min(r['end'], length))
        if e <= b:
            continue
        if out:
            out[-1]['end'] = b
        out.append({'begin': b, 'end': e})
        cursor = e
    if not out:
        return [{'begin': 0, 'end': length}]
    out[0]['begin'] = 0
    out[-1]['end'] = length
    return out
