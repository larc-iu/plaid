import sys
from pathlib import Path

import handwrite as h
import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _corpus_refs import IMP  # noqa: E402


def right(ctx):
    udplan.apply(ctx, [('replace_in_field', {'field': 'features', 'pattern': 'Aspect=Impf',
                                             'replacement': 'Aspect=Imp', 'whole': True})])


def wrong_missed_document(ctx):
    udplan.apply(ctx, [('set_feature', {'document': d, 'refs': refs, 'feature': 'Aspect', 'value': 'Imp'})
                       for d, refs in IMP.items() if d != 'Russian 3'])


def wrong_feature_sets(ctx):
    # The whole bundle rewritten as Aspect=Imp alone on the first document.
    udplan.apply(ctx, [('set_field', {'document': 'Russian 1', 'refs': IMP['Russian 1'], 'field': 'features',
                                      'value': 'Aspect=Imp'})])


def wrong_nothing(ctx):
    return h.no_plan()


def right_with_guideline(ctx):
    # The convention drafted as a guideline (glm53-stretch-2 rep 3's draft).
    right(ctx)
    h.add_guideline(ctx, 'Imperfective aspect is Aspect=Imp',
                    'The imperfective value of the Aspect feature is written Aspect=Imp, following the Universal '
                    'Dependencies feature inventory, never Aspect=Impf.')


def wrong_guideline_off(ctx):
    # The fix, and a guideline about something else.
    right(ctx)
    h.add_guideline(ctx, 'Perfective aspect', 'Perfective verbs carry Aspect=Perf.')
