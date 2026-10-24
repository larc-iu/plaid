import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _answers import reply  # noqa: E402


def right(ctx):
    return reply("\"c'est\" occurs **3** times in the project, **2** of them as \"C'est\" at the start of a "
                 'sentence and once in lower case.')


def wrong_case_kept(ctx):
    return reply("\"c'est\" occurs once in lower case, and \"C'est\" does not occur.")


def wrong_folded_capitals(ctx):
    return reply("\"c'est\" occurs 3 times, and all 3 begin with a capital C.")


def wrong_wrote(ctx):
    udplan.apply(ctx, [('set_field', {'document': 'French 1', 'refs': ['s1.w1'], 'field': 'lemma', 'value': 'x'})])
    return reply("\"c'est\" occurs 3 times, 2 of them as \"C'est\". I also fixed a lemma.", applied=True)
