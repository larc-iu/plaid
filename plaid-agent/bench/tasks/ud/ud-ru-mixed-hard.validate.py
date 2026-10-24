import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _answers import reply  # noqa: E402

D = 'Russian 2'


def fix(ctx):
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's2.w16', 'head': 15, 'deprel': 'xcomp'})])


def right(ctx):
    fix(ctx)
    return reply('I have planned бригадиром as xcomp of назначили. Counting it, there are **7** instrumental '
                 'nouns attached as xcomp in the project.', applied=True)


def wrong_count(ctx):
    # The count before the fix, not adjusted.
    fix(ctx)
    return reply('бригадиром is now xcomp. There are 6 instrumental nouns attached as xcomp.', applied=True)


def wrong_no_change(ctx):
    return reply('There are 7 instrumental nouns attached as xcomp, counting бригадиром.')


def wrong_collateral(ctx):
    # Fixed, and тетей re-attached as well.
    fix(ctx)
    udplan.apply(ctx, [('set_head', {'document': D, 'ref': 's11.w4', 'head': 3, 'deprel': 'obl'})])
    return reply('Done, and there are 7 of them.', applied=True)


def wrong_guideline(ctx):
    """The right result plus a project guideline nobody asked for."""
    conv = right(ctx)
    import handwrite
    handwrite.add_guideline(ctx)
    return conv
