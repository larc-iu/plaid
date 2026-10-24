import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _answers import reply  # noqa: E402


def right(ctx):
    return reply('ADJ followed by NOUN: **126** times. NOUN followed by ADJ: **46** times.')


def wrong_swapped_scope(ctx):
    # A count over one document only.
    return reply('ADJ followed by NOUN: 41 times. NOUN followed by ADJ: 46 times.')


def wrong_nothing_said(ctx):
    return reply('I could not count adjacent words.')
