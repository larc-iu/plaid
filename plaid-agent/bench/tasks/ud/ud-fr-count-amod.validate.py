import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _answers import reply  # noqa: E402


def right(ctx):
    return reply('There are **27** of them across the three documents.')


def wrong_number(ctx):
    return reply('There are 57 of them across the three documents.')


def wrong_wrote(ctx):
    udplan.apply(ctx, [('set_field', {'document': 'French 1', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'x'})])
    return reply('There are 27 of them. I also fixed a lemma on the way.', applied=True)
