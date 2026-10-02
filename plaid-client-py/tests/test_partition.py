"""The one sentence-partition builder the tokenizer and the ASR alignment
share (R1-DEBT-CORE-10)."""

import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

from plaid_client.workflows.partition import partition  # noqa: E402


def _tiles(parts, n):
    return (parts[0]['begin'] == 0 and parts[-1]['end'] == n
            and all(p['begin'] < p['end'] for p in parts)
            and all(a['end'] == b['begin'] for a, b in zip(parts, parts[1:])))


def test_any_ranges_become_a_partition_of_the_text():
    rng = random.Random(7)
    for _ in range(2000):
        n = rng.randint(1, 60)
        ranges = [{'begin': rng.randint(-5, n + 5), 'end': rng.randint(-5, n + 5)}
                  for _ in range(rng.randint(0, 8))]
        assert _tiles(partition(ranges, n), n), (ranges, n)


def test_gaps_go_to_the_sentence_before_and_the_first_reaches_the_start():
    assert partition([{'begin': 2, 'end': 4}, {'begin': 6, 'end': 8}], 10) == [
        {'begin': 0, 'end': 6}, {'begin': 6, 'end': 10}]


def test_overlaps_are_cut_at_the_sentence_before():
    assert partition([{'begin': 0, 'end': 6}, {'begin': 4, 'end': 10}], 10) == [
        {'begin': 0, 'end': 6}, {'begin': 6, 'end': 10}]


def test_no_ranges_make_one_sentence_and_no_text_none():
    assert partition([], 5) == [{'begin': 0, 'end': 5}]
    assert partition([{'begin': 0, 'end': 3}], 0) == []
