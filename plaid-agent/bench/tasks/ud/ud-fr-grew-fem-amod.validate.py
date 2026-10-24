import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _answers import reply  # noqa: E402

QUERY = 'pattern { N [upos=NOUN]; A [upos=ADJ, Gender=Fem]; N -[amod]-> A }'


def right(ctx):
    return reply(f'There are **34** of them, in 23 sentences across the three documents.\n\n`{QUERY}`')


def wrong_number(ctx):
    # Every ADJ amod of a NOUN, feminine or not.
    return reply(f'There are 80 of them.\n\n`pattern {{ N [upos=NOUN]; A [upos=ADJ]; N -[amod]-> A }}`')


def wrong_no_query(ctx):
    return reply('There are 34 of them across the three documents.')


def wrong_wrote(ctx):
    udplan.apply(ctx, [('set_field', {'document': 'French 1', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'x'})])
    return reply(f'There are 34 of them. I also fixed a lemma on the way.\n\n`{QUERY}`', applied=True)
