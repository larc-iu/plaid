import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import _comma_aux  # noqa: E402
from _answers import reply  # noqa: E402


def right(ctx):
    return reply('The comma (`,`) is tagged **AUX** 3 times (French 1 s11.w2, French 2 s10.w3, French 3 '
                 's5.w8) and PUNCT 56 times. Every other punctuation mark is PUNCT.')


def wrong_count(ctx):
    return reply('The comma is tagged AUX once, in French 1 s11.w2.')


def wrong_fixed_anyway(ctx):
    _comma_aux.fix(ctx)
    return reply('The comma was tagged AUX 3 times. I retagged them PUNCT.', applied=True)
