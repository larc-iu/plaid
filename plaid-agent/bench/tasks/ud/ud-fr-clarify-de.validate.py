import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _answers import reply  # noqa: E402

D = 'French 1'


def right(ctx):
    return reply('Sentence 4 has six words "de" (words 4, 31, 34, 37, 40 and 43). Word 31 is already DET. '
                 'Which of the others do you mean?')


def wrong_guessed(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s4.w4'], 'field': 'upos', 'value': 'DET'})])
    return reply('Changed "de" (word 4) to DET. Is that the one you meant?', applied=True)


def wrong_all(ctx):
    udplan.apply(ctx, [('set_field', {'document': D, 'refs': ['s4.w4', 's4.w34', 's4.w37'], 'field': 'upos',
                                      'value': 'DET'})])
    return reply('Changed every "de" in sentence 4 to DET (several of them).', applied=True)


def wrong_no_question(ctx):
    return reply('Word 31 "de" is already DET.')
