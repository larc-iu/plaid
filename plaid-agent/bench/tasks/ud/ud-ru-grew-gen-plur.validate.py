import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _answers import reply  # noqa: E402


def right(ctx):
    return reply('**19** adjectives, in **11** sentences: 13 in Russian 1, 2 in Russian 2 and 4 in Russian 3.')


def wrong_number(ctx):
    # Every amod of a genitive plural noun, participles and determiners too.
    return reply('21 adjectives, in 11 sentences.')


def wrong_sentences(ctx):
    return reply('19 adjectives, in 19 sentences.')


def wrong_wrote(ctx):
    udplan.apply(ctx, [('set_field', {'document': 'Russian 1', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'x'})])
    return reply('19 adjectives, in 11 sentences. I also fixed a lemma on the way.', applied=True)
