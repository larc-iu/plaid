import sys
from pathlib import Path

import handwrite as h

sys.path.insert(0, str(Path(__file__).parent))
import _comma_aux  # noqa: E402


def right(ctx):
    _comma_aux.fix(ctx)


def wrong_two_of_three(ctx):
    _comma_aux.fix(ctx, _comma_aux.COMMAS[:2])


def wrong_nothing(ctx):
    return h.no_plan()
